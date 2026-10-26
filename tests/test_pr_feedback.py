import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "plugins/symphony-lite/skills/github-workflow/scripts/pending-feedback.py"
spec = importlib.util.spec_from_file_location("pending_feedback", SCRIPT)
pending_feedback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pending_feedback)


def record():
    return {
        "schema_version": 1,
        "status": "pending",
        "pr": {
            "host": "github.com", "base_repo": "upstream/project", "number": 42,
            "url": "https://github.com/upstream/project/pull/42",
            "head_repo": "contributor/project", "head_ref": "fix/review",
        },
        "fix_commit": "a" * 40,
        "verification": {"command": "pytest", "outcome": "passed", "details": "3 passed"},
        "actions": [{
            "source": {
                "kind": "thread", "id": "PRRT_1",
                "url": "https://github.com/upstream/project/pull/42#discussion_r11",
                "body_sha256": "b" * 64,
            },
            "root_comment_id": 11, "thread_id": "PRRT_1", "verdict": "fixed",
            "reply_body": "> null check\n\nFixed in aaaaaaa. `value` is checked.",
            "resolve": True, "decision_context": None, "invariant_key": "null-value",
        }],
        "body_ticks": [{"original": "- [ ] P1 -- null check", "checked": "- [x] P1 -- null check"}],
        "residuals": [],
    }


def completed_record():
    value = record()
    value["status"] = "completed"
    value["actions"][0]["progress"] = {"reply_id": 100, "resolved": True}
    value["body_ticks"][0]["progress"] = {"applied": True}
    return value


class PendingFeedbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.source = self.directory / "source.json"
        self.handoff = self.directory / "pending.json"

    def tearDown(self):
        self.temp.cleanup()

    def write_json(self, path, value):
        path.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *map(str, args)],
            capture_output=True, text=True, check=False,
        )

    def test_create_validates_and_preserves_exact_utf8_bytes(self):
        raw = json.dumps(record(), ensure_ascii=False, indent=2).encode() + b"\n"
        self.source.write_bytes(raw)
        result = self.cli("create", "--input", self.source, "--path", self.handoff)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.handoff.read_bytes(), raw)
        validated = self.cli("validate", "--path", self.handoff)
        self.assertEqual(validated.returncode, 0, validated.stderr)
        self.assertEqual(json.loads(validated.stdout)["record"], record())
        if os.name != "nt":
            self.assertEqual(self.handoff.stat().st_mode & 0o777, 0o600)

    def test_preflight_refuses_existing_path_and_default_allocates_private_scratch(self):
        self.handoff.write_text("preserve", encoding="utf-8")
        refused = self.cli("preflight", "--path", self.handoff)
        self.assertEqual(refused.returncode, 1)
        self.assertIn("already exists", refused.stderr)
        self.assertEqual(self.handoff.read_text(encoding="utf-8"), "preserve")
        allocated = self.cli("preflight")
        self.assertEqual(allocated.returncode, 0, allocated.stderr)
        saved = Path(json.loads(allocated.stdout)["handoff"])
        self.assertTrue(saved.is_absolute())
        if os.name != "nt":
            self.assertEqual(saved.parent.stat().st_mode & 0o777, 0o700)

    def test_create_never_overwrites_existing_receipt(self):
        self.write_json(self.source, record())
        self.handoff.write_text("original", encoding="utf-8")
        result = self.cli("create", "--input", self.source, "--path", self.handoff)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.handoff.read_text(encoding="utf-8"), "original")

    def test_duplicate_json_keys_and_fabricated_identity_fail_before_creation(self):
        for raw in (
            b'{"schema_version":1,"schema_version":1}',
            json.dumps({**record(), "fix_commit": "--help"}).encode(),
            json.dumps({**record(), "pr": {**record()["pr"], "head_ref": "bad..ref"}}).encode(),
        ):
            with self.subTest(raw=raw[:50]):
                self.source.write_bytes(raw)
                result = self.cli("create", "--input", self.source, "--path", self.handoff)
                self.assertEqual(result.returncode, 1)
                self.assertFalse(self.handoff.exists())

    def test_checkpoint_is_atomic_and_cannot_rewrite_prepared_decision(self):
        self.write_json(self.source, record())
        self.assertEqual(self.cli("create", "--input", self.source, "--path", self.handoff).returncode, 0)
        original = self.handoff.read_bytes()
        changed = completed_record()
        changed["actions"][0]["reply_body"] = "different decision"
        self.write_json(self.source, changed)
        result = self.cli("checkpoint", "--input", self.source, "--path", self.handoff)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.handoff.read_bytes(), original)

    def test_checkpoint_accepts_progress_and_completed_requires_all_eligible_actions(self):
        self.write_json(self.source, record())
        self.assertEqual(self.cli("create", "--input", self.source, "--path", self.handoff).returncode, 0)
        self.write_json(self.source, completed_record())
        result = self.cli("checkpoint", "--input", self.source, "--path", self.handoff)
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads(self.cli("validate", "--path", self.handoff).stdout)["record"]
        self.assertEqual(saved, completed_record())

        invalid = completed_record()
        invalid["actions"][0]["progress"] = {"reply_id": 100, "resolved": False}
        self.write_json(self.source, invalid)
        result = self.cli("validate", "--path", self.source)
        self.assertEqual(result.returncode, 1)

    def test_checkpoint_preserves_typed_human_residual(self):
        batch = record()
        action = batch["actions"][0]
        context = {
            "quoted_feedback": "Change the API?", "investigation": "Read callers.",
            "decision_reason": "Requires API owner authority.",
            "options": [{"option": "Keep contract", "tradeoff": "Preserves callers."}],
            "recommendation": None,
        }
        action.update(verdict="needs-human", resolve=False, decision_context=context)
        batch["residuals"] = [{
            "type": "needs-human", "sources": [{"kind": "thread", "id": "PRRT_1"}],
            "decision_context": context, "thread_urls": [action["source"]["url"]],
        }]
        self.write_json(self.handoff, batch)
        updated = copy.deepcopy(batch)
        updated["status"] = "completed"
        updated["actions"][0]["progress"] = {"reply_id": 101, "resolved": False}
        updated["body_ticks"][0]["progress"] = {"applied": True}
        self.write_json(self.source, updated)
        result = self.cli("checkpoint", "--input", self.source, "--path", self.handoff)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["record"], updated)

    def test_publication_requires_fresh_fork_identity_and_reachable_saved_commit(self):
        batch = record()
        base = {
            "number": 42, "html_url": batch["pr"]["url"],
            "base": {"repo": {"full_name": batch["pr"]["base_repo"]}},
            "head": {"repo": {"full_name": batch["pr"]["head_repo"]}, "ref": "fix/review", "sha": "d" * 40},
        }
        comparison = {"status": "ahead", "merge_base_commit": {"sha": batch["fix_commit"]}}
        with patch.object(pending_feedback, "github_json", side_effect=[base, comparison]) as fetch:
            proof = pending_feedback.inspect_publication(batch)
        self.assertTrue(proof["verified"], proof)
        self.assertEqual(proof["head_repo"], "contributor/project")
        self.assertEqual(fetch.call_args_list[0].args[1], "repos/upstream/project/pulls/42")
        self.assertEqual(fetch.call_args_list[1].args[1], f"repos/contributor/project/compare/{'a' * 40}...{'d' * 40}")

    def test_publication_rejects_changed_identity_or_non_descendant_without_mutation(self):
        batch = record()
        changed = {
            "number": 42, "html_url": batch["pr"]["url"],
            "base": {"repo": {"full_name": batch["pr"]["base_repo"]}},
            "head": {"repo": {"full_name": "other/project"}, "ref": "fix/review", "sha": "d" * 40},
        }
        with patch.object(pending_feedback, "github_json", return_value=changed) as fetch:
            proof = pending_feedback.inspect_publication(batch)
        self.assertFalse(proof["verified"])
        self.assertIn("head repository/ref", proof["reason"])
        fetch.assert_called_once()

        changed["head"]["repo"]["full_name"] = batch["pr"]["head_repo"]
        unrelated = {"status": "diverged", "merge_base_commit": {"sha": "e" * 40}}
        with patch.object(pending_feedback, "github_json", side_effect=[changed, unrelated]):
            proof = pending_feedback.inspect_publication(batch)
        self.assertFalse(proof["verified"])
        self.assertIn("not positively reachable", proof["reason"])

    def test_no_change_publication_checks_identity_without_synthetic_compare(self):
        batch = record()
        batch["fix_commit"] = None
        metadata = {
            "number": 42, "html_url": batch["pr"]["url"],
            "base": {"repo": {"full_name": batch["pr"]["base_repo"]}},
            "head": {"repo": {"full_name": batch["pr"]["head_repo"]}, "ref": "fix/review", "sha": "d" * 40},
        }
        with patch.object(pending_feedback, "github_json", return_value=metadata) as fetch:
            proof = pending_feedback.inspect_publication(batch)
        self.assertTrue(proof["verified"], proof)
        self.assertIsNone(proof["comparison_status"])
        fetch.assert_called_once()

    def test_enterprise_identical_head_uses_saved_host_and_positive_compare_proof(self):
        batch = record()
        batch["pr"]["host"] = "git.example.com"
        batch["pr"]["url"] = "https://git.example.com/upstream/project/pull/42"
        batch["actions"][0]["source"]["url"] = batch["pr"]["url"] + "#discussion_r11"
        metadata = {
            "number": 42, "html_url": batch["pr"]["url"],
            "base": {"repo": {"full_name": batch["pr"]["base_repo"]}},
            "head": {"repo": {"full_name": batch["pr"]["head_repo"]}, "ref": "fix/review", "sha": batch["fix_commit"]},
        }
        comparison = {"status": "identical", "merge_base_commit": {"sha": batch["fix_commit"]}}
        with patch.object(pending_feedback, "github_json", side_effect=[metadata, comparison]) as fetch:
            proof = pending_feedback.inspect_publication(batch)
        self.assertTrue(proof["verified"], proof)
        self.assertEqual(proof["comparison_status"], "identical")
        self.assertEqual(fetch.call_args_list[0].args[0], "git.example.com")


if __name__ == "__main__":
    unittest.main()

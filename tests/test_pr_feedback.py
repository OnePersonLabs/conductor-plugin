import copy
from datetime import timedelta
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
SCRIPT = ROOT / "plugins/conductor/skills/github-workflow/scripts/pending-feedback.py"
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
        environment = os.environ.copy()
        environment.update(TEMP=str(self.directory), TMP=str(self.directory), TMPDIR=str(self.directory))
        return subprocess.run(
            [sys.executable, str(SCRIPT), *map(str, args)],
            capture_output=True, text=True, check=False, env=environment,
        )

    def test_create_validates_and_preserves_exact_utf8_bytes(self):
        raw = json.dumps(record(), ensure_ascii=False, indent=2).encode() + b"\n"
        self.source.write_bytes(raw)
        result = self.cli("create", "--input", self.source, "--path", self.handoff)
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads(self.handoff.read_text(encoding="utf-8"))
        self.assertEqual({key: value for key, value in saved.items() if key != "retention"}, record())
        self.assertEqual(saved["retention"]["purpose"], "resume a reviewed PR feedback batch")
        validated = self.cli("validate", "--path", self.handoff)
        self.assertEqual(validated.returncode, 0, validated.stderr)
        self.assertEqual(json.loads(validated.stdout)["record"], saved)
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
        self.assertTrue((saved.parent / ".conductor-feedback-owner.json").is_file())
        if os.name != "nt":
            self.assertEqual(saved.parent.stat().st_mode & 0o777, 0o700)
        self.assertTrue(pending_feedback.cleanup_owned_scratch(saved, temp_root=self.directory))

    def test_retention_expires_after_inactivity_and_has_fixed_maximum(self):
        created = pending_feedback.now()
        retained = pending_feedback.attach_retention(record(), created)
        self.assertFalse(pending_feedback.is_stale(retained, created + timedelta(days=6)))
        self.assertTrue(pending_feedback.is_stale(retained, created + timedelta(days=7)))
        retained["retention"]["expires_at"] = (created + timedelta(days=8)).isoformat()
        with self.assertRaisesRegex(ValueError, "maximum recovery window"):
            pending_feedback.validate(retained)

    def test_legacy_receipts_are_stale_and_cleanup_never_deletes_pending_receipts(self):
        legacy = record()
        self.assertTrue(pending_feedback.is_stale(legacy))
        scratch = self.directory / "conductor-pending-feedback-fixture"
        scratch.mkdir()
        (scratch / ".conductor-feedback-owner.json").write_text(json.dumps({"purpose": "temporary PR feedback handoff", "created_at": pending_feedback.now().isoformat()}), encoding="utf-8")
        pending = scratch / "pending.json"
        self.write_json(pending, pending_feedback.attach_retention(record()))
        result = pending_feedback.cleanup_expired_scratch(pending_feedback.now() + timedelta(days=8), self.directory)
        self.assertNotIn(str(pending), result["removed"])
        self.assertTrue(pending.exists())

    def test_cleanup_requires_terminal_proof_and_recovers_after_proof_before_unlink(self):
        root = self.directory
        scratch = root / "conductor-pending-feedback-terminal"
        scratch.mkdir()
        owner = {"purpose": "temporary PR feedback handoff", "owner": "Conductor github-workflow feedback helper", "created_at": pending_feedback.now().isoformat()}
        (scratch / ".conductor-feedback-owner.json").write_text(json.dumps(owner), encoding="utf-8")
        pending = scratch / "pending.json"
        batch = pending_feedback.attach_retention(completed_record())
        self.write_json(pending, batch)
        result = pending_feedback.cleanup_expired_scratch(pending_feedback.now() + timedelta(days=8), root)
        self.assertEqual(result["removed"], [])
        self.assertTrue(pending.exists())

        batch["finalization"] = {"disposition": "completed", "verified_at": pending_feedback.now().isoformat()}
        self.write_json(pending, batch)
        result = pending_feedback.cleanup_expired_scratch(pending_feedback.now() + timedelta(days=8), root)
        self.assertEqual(result["removed"], [str(scratch)])
        self.assertFalse(scratch.exists())

    def test_cleanup_reclaims_old_empty_helper_named_directory(self):
        scratch = self.directory / "conductor-pending-feedback-unowned"
        scratch.mkdir()
        result = pending_feedback.cleanup_expired_scratch(pending_feedback.now() + timedelta(days=100), self.directory)
        self.assertIn(str(scratch), result["removed"])
        self.assertFalse(scratch.exists())

    def test_receipt_lock_suppresses_concurrent_cleanup_or_writer(self):
        with pending_feedback.receipt_lock(self.handoff):
            with self.assertRaisesRegex(ValueError, "verify it stopped, then remove the lock"):
                with pending_feedback.receipt_lock(self.handoff):
                    self.fail("second writer unexpectedly acquired the receipt lock")

    def test_unreadable_receipt_lock_is_preserved_for_operator_recovery(self):
        lock = self.directory / ".conductor-feedback.lock"
        lock.write_text("partial write", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "lock is unreadable"):
            with pending_feedback.receipt_lock(self.handoff):
                self.fail("unreadable lock was ignored")
        self.assertEqual(lock.read_text(encoding="utf-8"), "partial write")

    def test_stale_owner_lock_fails_closed_until_explicitly_removed(self):
        lock = self.directory / ".conductor-feedback.lock"
        lock.write_text(json.dumps({"token": "old", "pid": 2147483647, "hostname": pending_feedback.socket.gethostname()}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "verify it stopped, then remove the lock"):
            with pending_feedback.receipt_lock(self.handoff):
                self.fail("stale lock was removed automatically")
        self.assertTrue(lock.exists())
        lock.unlink()
        with pending_feedback.receipt_lock(self.handoff):
            self.assertTrue(self.handoff.parent.exists())

    def test_finalize_requires_reconciliation_and_removes_only_receipt(self):
        completed = pending_feedback.attach_retention(completed_record())
        self.write_json(self.handoff, completed)
        with patch("sys.argv", [str(SCRIPT), "finalize", "--path", str(self.handoff), "--disposition", "completed"]):
            with self.assertRaisesRegex(ValueError, "requires fresh remote reconciliation"):
                pending_feedback.main(self.directory)
        self.assertTrue(self.handoff.exists())
        with patch("sys.argv", [str(SCRIPT), "finalize", "--path", str(self.handoff), "--disposition", "completed", "--reconciled"]):
            with patch("builtins.print"):
                pending_feedback.main(self.directory)
        self.assertFalse(self.handoff.exists())

    def test_finalize_preserves_unresolved_human_residuals(self):
        batch = record()
        context = {"quoted_feedback": "Change API?", "investigation": "Read callers.", "decision_reason": "User choice needed.", "options": [{"option": "A", "tradeoff": "Changes API."}], "recommendation": None}
        batch["actions"][0].update(verdict="needs-human", resolve=False, decision_context=context)
        batch["residuals"] = [{"type": "needs-human", "sources": [{"kind": "thread", "id": "PRRT_1"}], "decision_context": context, "thread_urls": [batch["actions"][0]["source"]["url"]]}]
        self.write_json(self.handoff, pending_feedback.attach_retention(batch))
        with patch("sys.argv", [str(SCRIPT), "finalize", "--path", str(self.handoff), "--disposition", "cancelled", "--reconciled"]):
            with self.assertRaisesRegex(ValueError, "unresolved human residuals"):
                pending_feedback.main(self.directory)
        self.assertTrue(self.handoff.exists())

    def test_cleanup_receipt_requires_matching_terminal_status_and_no_residuals(self):
        invalid = pending_feedback.attach_retention(record())
        invalid["finalization"] = {"disposition": "completed", "verified_at": pending_feedback.now().isoformat()}
        with self.assertRaisesRegex(ValueError, "requires completed receipt status"):
            pending_feedback.validate(invalid)
        invalid = pending_feedback.attach_retention(completed_record())
        invalid["finalization"] = {"disposition": "cancelled", "verified_at": pending_feedback.now().isoformat()}
        with self.assertRaisesRegex(ValueError, "requires pending receipt status"):
            pending_feedback.validate(invalid)

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
        self.assertEqual({key: value for key, value in saved.items() if key != "retention"}, completed_record())

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
        self.write_json(self.source, batch)
        self.assertEqual(self.cli("create", "--input", self.source, "--path", self.handoff).returncode, 0)
        updated = copy.deepcopy(batch)
        updated["status"] = "completed"
        updated["actions"][0]["progress"] = {"reply_id": 101, "resolved": False}
        updated["body_ticks"][0]["progress"] = {"applied": True}
        self.write_json(self.source, updated)
        result = self.cli("checkpoint", "--input", self.source, "--path", self.handoff)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({key: value for key, value in json.loads(result.stdout)["record"].items() if key != "retention"}, updated)

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

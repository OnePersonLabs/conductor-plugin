"""Preserve a judged feedback batch. This helper never mutates GitHub."""

# Adapted from EveryInc/compound-engineering-plugin ce-resolve-pr-feedback at
# 8673dfb96ad62c5e0cb6bc50fce312e7a66487a0 (MIT); see THIRD_PARTY_NOTICES.md.

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from uuid import uuid4
from pathlib import Path
from urllib.parse import urlsplit


SCHEMA_VERSION = 1
INACTIVE_DAYS = 7
MAX_RECOVERY_DAYS = 7
VERDICTS = {"fixed", "fixed-differently", "replied", "not-addressing", "declined", "needs-human"}
KINDS = {"thread", "comment", "review"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def string(value: object, name: str, pattern: str | None = None) -> str:
    require(isinstance(value, str) and bool(value), f"{name} must be a nonempty string")
    if pattern:
        require(re.fullmatch(pattern, value) is not None, f"invalid {name}")
    return value


def positive_int(value: object, name: str) -> None:
    require(type(value) is int and value > 0, f"{name} must be a positive integer")


def object_value(value: object, name: str) -> dict:
    require(isinstance(value, dict), f"{name} must be an object")
    return value


def array(value: object, name: str) -> list:
    require(isinstance(value, list), f"{name} must be an array")
    return value


def decision(value: object) -> None:
    context = object_value(value, "decision_context")
    for key in ("quoted_feedback", "investigation", "decision_reason"):
        string(context.get(key), key)
    options = array(context.get("options"), "options")
    require(bool(options), "decision options must not be empty")
    for option in options:
        option = object_value(option, "option")
        string(option.get("option"), "option")
        string(option.get("tradeoff"), "tradeoff")
    require("recommendation" in context, "missing recommendation")
    if context["recommendation"] is not None:
        string(context["recommendation"], "recommendation")


def progress(value: object) -> None:
    value = object_value(value, "progress")
    require(set(value) <= {"reply_id", "reply_url", "resolved", "applied"}, "unknown progress field")
    if "reply_id" in value:
        positive_int(value["reply_id"], "reply_id")
    if "reply_url" in value:
        string(value["reply_url"], "reply_url")
    for key in ("resolved", "applied"):
        if key in value:
            require(type(value[key]) is bool, f"{key} must be boolean")


def validate(record: object) -> dict:
    record = object_value(record, "record")
    require(type(record.get("schema_version")) is int and record["schema_version"] == SCHEMA_VERSION, "unsupported schema_version")
    require(record.get("status") in {"pending", "completed"}, "invalid status")
    if "retention" in record:
        retention = object_value(record["retention"], "retention")
        require(retention.get("purpose") == "resume a reviewed PR feedback batch", "invalid retention purpose")
        string(retention.get("owner"), "retention owner")
        for key in ("created_at", "last_activity_at", "expires_at"):
            timestamp(retention.get(key), f"retention.{key}")
        created = timestamp(retention["created_at"], "retention.created_at")
        last_activity = timestamp(retention["last_activity_at"], "retention.last_activity_at")
        expires = timestamp(retention["expires_at"], "retention.expires_at")
        require(created <= last_activity < expires, "invalid retention time ordering")
        require(expires <= created + timedelta(days=MAX_RECOVERY_DAYS), "retention exceeds the maximum recovery window")
    if "finalization" in record:
        finalization = object_value(record["finalization"], "finalization")
        require(finalization.get("disposition") in {"completed", "cancelled"}, "invalid finalization disposition")
        timestamp(finalization.get("verified_at"), "finalization.verified_at")
        require(not record.get("residuals"), "finalized receipt cannot contain unresolved human residuals")
        if finalization["disposition"] == "completed":
            require(record["status"] == "completed", "completed finalization requires completed receipt status")
        else:
            require(record["status"] == "pending", "cancelled finalization requires pending receipt status")
    pr = object_value(record.get("pr"), "pr")
    host = string(pr.get("host"), "host", r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]+)?")
    for key in ("base_repo", "head_repo"):
        string(pr.get(key), key, r"[A-Za-z0-9_-][A-Za-z0-9_.-]*/(?!\.{1,2}$)[A-Za-z0-9_.-]+")
    positive_int(pr.get("number"), "PR number")
    expected_url = f"https://{host}/{pr['base_repo']}/pull/{pr['number']}"
    require(pr.get("url") == expected_url, "PR URL does not match host/base/number")
    ref = string(pr.get("head_ref"), "head_ref")
    require(not re.search(r"[\x00-\x20\x7f~^:?*\[\\]", ref) and not any(token in ref for token in ("..", "@{")), "invalid head_ref")
    require(not ref.startswith(("-", "/", ".")) and not ref.endswith(("/", ".", ".lock")) and "//" not in ref, "invalid head_ref")
    require("fix_commit" in record, "missing fix_commit")
    if record["fix_commit"] is not None:
        string(record["fix_commit"], "fix_commit", r"[0-9a-f]{40}")
    verification = object_value(record.get("verification"), "verification")
    require(verification.get("outcome") in {"passed", "pre-existing-failure", "failed", "not-run"}, "invalid verification outcome")
    for key in ("command", "details"):
        require(isinstance(verification.get(key), str), f"verification.{key} must be a string")
    seen = set()
    for action in array(record.get("actions"), "actions"):
        action = object_value(action, "action")
        source = object_value(action.get("source"), "source")
        require(source.get("kind") in KINDS, "invalid source kind")
        source_id = string(source.get("id"), "source id", r"[A-Za-z0-9_+=:-]+")
        key = (source["kind"], source_id)
        require(key not in seen, "duplicate source identity")
        seen.add(key)
        url = urlsplit(string(source.get("url"), "source URL"))
        require(url.scheme == "https" and url.netloc == host and url.path.rstrip("/") == f"/{pr['base_repo']}/pull/{pr['number']}" and not url.query, "source URL does not belong to PR")
        string(source.get("body_sha256"), "body_sha256", r"[0-9a-f]{64}")
        require(action.get("verdict") in VERDICTS, "invalid verdict")
        string(action.get("reply_body"), "reply_body")
        require(type(action.get("resolve")) is bool, "resolve must be boolean")
        require(action["resolve"] == (source["kind"] == "thread" and action["verdict"] != "needs-human"), "resolve must match the source kind and verdict")
        if source["kind"] == "thread":
            positive_int(action.get("root_comment_id"), "root_comment_id")
            string(action.get("thread_id"), "thread_id", r"[A-Za-z0-9_+=:-]+")
        else:
            require(action.get("root_comment_id") is None and action.get("thread_id") is None and not action["resolve"], "non-thread action cannot resolve")
        if action["verdict"] == "needs-human":
            require(not action["resolve"], "needs-human action cannot resolve")
            decision(action.get("decision_context"))
        else:
            require(action.get("decision_context") is None, "decision_context belongs to needs-human")
        require("invariant_key" in action, "missing invariant_key")
        if action["invariant_key"] is not None:
            string(action["invariant_key"], "invariant_key", r"[A-Za-z0-9._:-]{1,120}")
        if "progress" in action:
            progress(action["progress"])
        if record["status"] == "completed":
            observed = action.get("progress", {})
            positive_int(observed.get("reply_id"), "completed action reply_id")
            require(not action["resolve"] or observed.get("resolved") is True, "completed action must have its required resolution")
    for tick in array(record.get("body_ticks"), "body_ticks"):
        tick = object_value(tick, "body tick")
        original = string(tick.get("original"), "original checklist bullet")
        require(original.startswith("- [ ] ") and "\n" not in original and "\r" not in original, "invalid checklist bullet")
        require(tick.get("checked") == original.replace("- [ ] ", "- [x] ", 1), "body tick must only check the saved bullet")
        if "progress" in tick:
            progress(tick["progress"])
        if record["status"] == "completed":
            require(tick.get("progress", {}).get("applied") is True, "completed body tick must be applied")
    for residual in array(record.get("residuals"), "residuals"):
        residual = object_value(residual, "residual")
        require(residual.get("type") == "needs-human", "invalid residual type")
        sources = array(residual.get("sources"), "residual sources")
        require(bool(sources), "residual sources must not be empty")
        for source in sources:
            source = object_value(source, "residual source")
            require(source.get("kind") in KINDS, "invalid residual source kind")
            string(source.get("id"), "residual source id", r"[A-Za-z0-9_+=:-]+")
        decision(residual.get("decision_context"))
        thread_urls = array(residual.get("thread_urls"), "thread_urls")
        require(not any(source["kind"] == "thread" for source in sources) or bool(thread_urls), "thread residual must carry thread_urls")
        for url in thread_urls:
            string(url, "thread URL")
    return record


def timestamp(value: object, name: str) -> datetime:
    string(value, name)
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"invalid {name}") from error
    require(result.tzinfo is not None, f"{name} must include a timezone")
    return result.astimezone(timezone.utc)


def now() -> datetime:
    return datetime.now(timezone.utc)


def is_stale(record: dict, at: datetime | None = None) -> bool:
    retention = record.get("retention")
    if retention is None:
        # Legacy receipts have no trustworthy creation time and require a fresh
        # remote reconciliation and a new judgment before saved actions resume.
        return True
    at = at or now()
    return at - timestamp(retention["last_activity_at"], "retention.last_activity_at") >= timedelta(days=INACTIVE_DAYS) or at >= timestamp(retention["expires_at"], "retention.expires_at")


def attach_retention(record: dict, at: datetime | None = None) -> dict:
    at = at or now()
    stamp = at.isoformat().replace("+00:00", "Z")
    record = dict(record)
    record["retention"] = {
        "purpose": "resume a reviewed PR feedback batch",
        "owner": "Conductor github-workflow feedback helper",
        "created_at": stamp,
        "last_activity_at": stamp,
        "expires_at": (at + timedelta(days=MAX_RECOVERY_DAYS)).isoformat().replace("+00:00", "Z"),
    }
    return record


def is_link(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


@contextmanager
def receipt_lock(path: Path, temp_root: Path | None = None):
    parent = path.parent
    if is_link(path):
        raise ValueError(f"handoff path is a symlink or junction: {path}")
    if is_link(parent):
        raise ValueError(f"handoff parent is a symlink or junction: {parent}")
    temp_root = Path(temp_root or tempfile.gettempdir()).resolve()
    resolved = parent.resolve(strict=True)
    owned_scratch = parent.name.startswith("conductor-pending-feedback-") and resolved.parent == temp_root
    lock_path = parent.with_name(parent.name + ".conductor-feedback.lock") if owned_scratch else parent / ".conductor-feedback.lock"
    token = str(uuid4())
    owner = {"token": token, "pid": os.getpid(), "hostname": socket.gethostname()}
    for attempt in range(2):
        try:
            descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(owner, stream)
                stream.flush()
                os.fsync(stream.fileno())
            break
        except FileExistsError:
            if is_link(lock_path):
                raise ValueError(f"handoff lock is a symlink or junction: {lock_path}")
            try:
                existing = json.loads(lock_path.read_text(encoding="utf-8"))
            except (OSError, ValueError, KeyError, TypeError):
                raise ValueError(f"handoff lock is unreadable; inspect and remove it only after its owner stops: {lock_path}")
            if existing.get("hostname") != socket.gethostname():
                raise ValueError(f"handoff is locked by another host: {lock_path}")
            require(type(existing.get("pid")) is int and existing["pid"] > 0, f"handoff lock has invalid owner data: {lock_path}")
            raise ValueError(f"handoff lock belongs to PID {existing['pid']}; verify it stopped, then remove the lock to recover: {lock_path}")
    else:
        raise ValueError(f"could not acquire handoff lock: {lock_path}")
    try:
        yield
    finally:
        try:
            current = json.loads(lock_path.read_text(encoding="utf-8"))
            if current.get("token") == token:
                lock_path.unlink(missing_ok=True)
        except FileNotFoundError:
            pass


def cleanup_owned_scratch(path: Path, *, temp_root: Path | None = None) -> bool:
    """Remove the helper-created scratch directory, never its caller's parent."""
    temp_root = Path(temp_root or tempfile.gettempdir()).resolve()
    parent = path.parent
    if is_link(parent) or not parent.name.startswith("conductor-pending-feedback-"):
        return False
    resolved = parent.resolve(strict=True)
    if resolved.parent != temp_root or path.name != "pending.json":
        return False
    manifest = parent / ".conductor-feedback-owner.json"
    if is_link(manifest) or not manifest.is_file():
        return False
    ownership = json.loads(manifest.read_text(encoding="utf-8"), object_pairs_hook=unique_keys)
    require(ownership.get("purpose") == "temporary PR feedback handoff" and ownership.get("owner") == "Conductor github-workflow feedback helper", "invalid temporary handoff directory owner")
    remaining = {item.name for item in parent.iterdir()} - {path.name, manifest.name}
    if remaining:
        return False
    manifest.unlink()
    parent.rmdir()
    return True


def remove_receipt(path: Path, *, temp_root: Path | None = None) -> bool:
    if is_link(path):
        raise ValueError(f"refusing to remove a handoff symlink or junction: {path}")
    path.unlink(missing_ok=True)
    return cleanup_owned_scratch(path, temp_root=temp_root)


def unique_keys(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def read_record(path: Path) -> tuple[dict, bytes]:
    raw = path.read_bytes()
    record = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_keys,
                        parse_constant=reject_constant)
    return validate(record), raw


def prepared_content(record: dict) -> dict:
    return {
        "schema_version": record["schema_version"],
        "pr": record["pr"], "fix_commit": record["fix_commit"], "verification": record["verification"],
        "actions": [{key: value for key, value in action.items() if key != "progress"} for action in record["actions"]],
        "body_ticks": [{key: value for key, value in tick.items() if key != "progress"} for tick in record["body_ticks"]],
        "residuals": record["residuals"],
    }


def write_record(path: Path, raw: bytes, *, checkpoint: bool) -> None:
    if checkpoint:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".pending-feedback-", delete=False) as temp:
                temporary = Path(temp.name)
                temp.write(raw)
                temp.flush()
                os.fsync(temp.fileno())
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    else:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as target:
            target.write(raw)
            target.flush()
            os.fsync(target.fileno())
    read_record(path)


def cleanup_expired_scratch(at: datetime | None = None, root: Path | None = None) -> dict:
    """Prune only expired, schema-valid helper-owned scratch receipts."""
    at = at or now()
    root = Path(root or tempfile.gettempdir()).resolve()
    removed = []
    retained = []
    failures = []
    for parent in root.glob("conductor-pending-feedback-*"):
        try:
            if is_link(parent) or not parent.is_dir():
                continue
            if parent.resolve(strict=True).parent != root:
                retained.append(str(parent))
                continue
            path = parent / "pending.json"
            if is_link(path):
                continue
            with receipt_lock(path, root):
                manifest = parent / ".conductor-feedback-owner.json"
                if is_link(manifest) or not manifest.is_file():
                    # Reclaim only an empty, helper-named directory after its
                    # seven-day no-activity window. Any content blocks removal.
                    if any(parent.iterdir()) or at.timestamp() - parent.stat().st_mtime < INACTIVE_DAYS * 86400:
                        retained.append(str(path))
                        continue
                    parent.rmdir()
                    removed.append(str(parent))
                    continue
                ownership = json.loads(manifest.read_text(encoding="utf-8"), object_pairs_hook=unique_keys)
                require(ownership.get("purpose") == "temporary PR feedback handoff", "invalid temporary handoff directory owner")
                require(ownership.get("owner") == "Conductor github-workflow feedback helper", "invalid temporary handoff owner")
                if path.is_file():
                    record, _ = read_record(path)
                    terminal = record.get("finalization")
                    if record.get("residuals"):
                        retained.append(str(path))
                        continue
                    if not terminal:
                        if is_stale(record, at):
                            retained.append(str(path))
                            failures.append({"path": str(path), "error": "stale pending receipt requires fresh remote reconciliation and explicit finalize"})
                            continue
                        retained.append(str(path))
                        continue
                    if remove_receipt(path, temp_root=root):
                        removed.append(str(parent))
                    else:
                        removed.append(str(path))
                    continue
                created = timestamp(ownership.get("created_at"), "scratch.created_at")
                if at < created + timedelta(days=MAX_RECOVERY_DAYS):
                    retained.append(str(path))
                    continue
                remaining = {item.name for item in parent.iterdir()} - {manifest.name}
                if remaining:
                    retained.append(str(path))
                    continue
                manifest.unlink()
                parent.rmdir()
                removed.append(str(parent))
        except (OSError, ValueError, TypeError) as error:
            failures.append({"path": str(parent), "error": str(error)})
    return {"removed": removed, "retained": retained, "failures": failures}


def github_json(host: str, endpoint: str) -> dict:
    result = subprocess.run(
        ["gh", "api", "--hostname", host, "--method", "GET", endpoint],
        capture_output=True, text=True, check=False,
    )
    require(result.returncode == 0, result.stderr.strip() or f"GitHub GET failed: {endpoint}")
    return object_value(json.loads(result.stdout), "GitHub response")


def inspect_publication(record: dict) -> dict:
    proof = {"verified": False, "reason": "", "head_sha": None,
             "head_repo": None, "head_ref": None, "comparison_status": None}
    pr = record["pr"]
    try:
        fresh = github_json(pr["host"], f"repos/{pr['base_repo']}/pulls/{pr['number']}")
        require(fresh.get("number") == pr["number"] and fresh.get("html_url") == pr["url"],
                "fresh PR host/number/URL differs from the saved PR")
        base = object_value(fresh.get("base"), "fresh base")
        require(object_value(base.get("repo"), "fresh base repository").get("full_name") == pr["base_repo"],
                "fresh PR base repository differs from the saved PR")
        head = object_value(fresh.get("head"), "fresh head")
        proof["head_repo"] = object_value(head.get("repo"), "fresh head repository").get("full_name")
        proof["head_ref"] = head.get("ref")
        proof["head_sha"] = string(head.get("sha"), "fresh head SHA", r"[0-9a-f]{40}")
        require(proof["head_repo"] == pr["head_repo"] and proof["head_ref"] == pr["head_ref"],
                "fresh PR head repository/ref differs from the saved PR")
        commit = record["fix_commit"]
        if commit is None:
            proof.update(verified=True, reason="saved batch created no fix commit")
            return proof
        comparison = github_json(pr["host"], f"repos/{proof['head_repo']}/compare/{commit}...{proof['head_sha']}")
        proof["comparison_status"] = comparison.get("status")
        merge_base = object_value(comparison.get("merge_base_commit"), "comparison merge base")
        require(proof["comparison_status"] in {"ahead", "identical"} and merge_base.get("sha") == commit,
                "recorded fix commit is not positively reachable from the fresh PR head")
        proof.update(verified=True, reason="recorded fix commit is reachable from the fresh PR head")
    except (OSError, ValueError, TypeError) as error:
        proof["reason"] = str(error)
    return proof


def main(temp_root: Path | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    preflight = subcommands.add_parser("preflight")
    preflight.add_argument("--path")
    for command in ("create", "validate", "checkpoint", "inspect-publication", "finalize", "cleanup"):
        command_parser = subcommands.add_parser(command)
        if command != "cleanup":
            command_parser.add_argument("--path", required=True)
        if command in {"create", "checkpoint"}:
            command_parser.add_argument("--input", required=True)
        if command == "finalize":
            command_parser.add_argument("--disposition", choices={"completed", "cancelled"}, required=True)
            command_parser.add_argument("--reconciled", action="store_true", help="confirm fresh remote inspection found no unresolved write")
    args = parser.parse_args()
    if args.command == "cleanup":
        print(json.dumps(cleanup_expired_scratch(root=temp_root), ensure_ascii=False))
        return
    cleanup = cleanup_expired_scratch(root=temp_root)
    for item in cleanup["failures"]:
        print(f"pending feedback cleanup: {item['path']}: {item['error']}", file=sys.stderr)
    if args.command == "preflight":
        if args.path:
            path = Path(args.path).absolute()
        else:
            directory = Path(tempfile.mkdtemp(prefix="conductor-pending-feedback-"))
            manifest = {"purpose": "temporary PR feedback handoff", "owner": "Conductor github-workflow feedback helper", "created_at": now().isoformat().replace("+00:00", "Z")}
            (directory / ".conductor-feedback-owner.json").write_text(json.dumps(manifest) + "\n", encoding="utf-8")
            path = directory / "pending.json"
        require(not os.path.lexists(path), "handoff destination already exists")
        require(path.parent.is_dir(), "handoff parent directory does not exist")
        with tempfile.TemporaryFile(dir=path.parent):
            pass
        print(json.dumps({"handoff": str(path)}))
        return
    path = Path(args.path).absolute()
    if args.command == "finalize":
        require(args.reconciled, "finalize requires fresh remote reconciliation; preserve this receipt if any remote write is uncertain")
        with receipt_lock(path):
            record, _ = read_record(path)
            if args.disposition == "completed":
                require(record["status"] == "completed", "only a completed receipt can be finalized as completed")
            else:
                require(record["status"] == "pending", "only a pending receipt can be finalized as cancelled")
            require(not record["residuals"], "receipt contains unresolved human residuals; preserve them until addressed or transferred to their existing owner")
            record = dict(record)
            record["finalization"] = {"disposition": args.disposition, "verified_at": now().isoformat().replace("+00:00", "Z")}
            write_record(path, (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8"), checkpoint=True)
            scratch_removed = remove_receipt(path)
        print(json.dumps({"handoff": str(path), "disposition": args.disposition, "deleted": True, "scratch_directory_removed": scratch_removed}, ensure_ascii=False))
        return
    if args.command in {"validate", "inspect-publication"}:
        with receipt_lock(path):
            record, _ = read_record(path)
        if args.command == "validate" and is_stale(record):
            raise ValueError("receipt is stale; reconcile the remote PR and feedback before any saved action, then make a fresh judgment or finalize it")
    else:
        with receipt_lock(path):
            record, raw = read_record(Path(args.input))
            if args.command == "checkpoint":
                previous, _ = read_record(path)
                require(not is_stale(previous), "receipt is stale; reconcile the remote PR and feedback before continuing")
                require(prepared_content(previous) == prepared_content(record), "checkpoint cannot replace the prepared batch")
                record = dict(record)
                retention = dict(previous.get("retention") or {})
                require(bool(retention), "legacy receipt is stale; create a freshly judged receipt before continuing")
                retention["last_activity_at"] = now().isoformat().replace("+00:00", "Z")
                record["retention"] = retention
                raw = (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            elif args.command == "create":
                record = attach_retention(record)
                raw = (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            write_record(path, raw, checkpoint=args.command == "checkpoint")
    output = {"handoff": str(path), "record": record}
    if args.command == "inspect-publication":
        output["publication"] = inspect_publication(record)
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError) as error:
        print(f"pending feedback: {error}", file=sys.stderr)
        sys.exit(1)

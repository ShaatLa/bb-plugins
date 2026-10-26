"""Copy disabled Tasks, Tasks Plus or Agent Board storage into a new Work Board installation."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess


def import_tasks(source: Path, destination: Path, source_plugin: str = "tasks", destination_plugin: str = "work-board") -> None:
    if source_plugin not in ("tasks", "tasks-plus", "agent-board", "work-board") or destination_plugin not in ("work-board", "agent-board", "tasks-plus") or source_plugin == destination_plugin:
        raise ValueError("Unsupported source/destination plugin pair")
    if not (source / "data.db").is_file():
        raise ValueError(f"Source database not found: {source / 'data.db'}")
    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    try:
        descriptor = os.open(destination / "data.db", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        with sqlite3.connect((source / "data.db").resolve().as_uri() + "?mode=ro", uri=True) as original:
            with sqlite3.connect(destination / "data.db") as copied:
                original.backup(copied)
                old = f"/api/v1/plugins/{source_plugin}/"
                new = f"/api/v1/plugins/{destination_plugin}/"
                tables = copied.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
                # Attachment URLs also occur inside question/history JSON and templates.
                for (table,) in tables:
                    quoted_table = '"' + table.replace('"', '""') + '"'
                    for column in copied.execute(f"PRAGMA table_info({quoted_table})").fetchall():
                        quoted_column = '"' + column[1].replace('"', '""') + '"'
                        copied.execute(
                            f"UPDATE {quoted_table} SET {quoted_column}=replace({quoted_column}, ?, ?) "
                            f"WHERE typeof({quoted_column})='text' AND instr({quoted_column}, ?)>0",
                            (old, new, old),
                        )
                if copied.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                    raise ValueError("Copied database failed its integrity check")
        if (source / "blobs").exists():
            shutil.copytree(source / "blobs", destination / "blobs")
    except BaseException:
        shutil.rmtree(destination)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path.home() / ".bb")
    parser.add_argument("--source-plugin", choices=("tasks", "tasks-plus", "agent-board", "work-board"), default="tasks")
    parser.add_argument("--destination-plugin", choices=("work-board", "agent-board", "tasks-plus"), default="work-board")
    args = parser.parse_args()
    plugins = json.loads(subprocess.check_output(["bb", "plugin", "list", "--json"], text=True))["plugins"]
    if any(p["id"] in (args.source_plugin, args.destination_plugin, "tasks") and p["enabled"] for p in plugins):
        parser.error("Disable the source plugin and Work Board before importing; the destination must not exist")
    import_tasks(args.data_dir / "plugins" / args.source_plugin, args.data_dir / "plugins" / args.destination_plugin, args.source_plugin, args.destination_plugin)
    print(f"Copied database and attachments to {args.destination_plugin}. Source storage is unchanged; restore plugin settings separately.")


if __name__ == "__main__":
    main()

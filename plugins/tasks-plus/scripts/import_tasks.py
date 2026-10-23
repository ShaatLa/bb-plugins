"""Copy disabled BB Tasks storage into a new Tasks Plus installation."""
import argparse
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess


def import_tasks(source: Path, destination: Path) -> None:
    if not (source / "data.db").is_file():
        raise ValueError(f"Tasks database not found: {source / 'data.db'}")
    destination.mkdir(parents=True, exist_ok=False)
    try:
        with sqlite3.connect((source / "data.db").resolve().as_uri() + "?mode=ro", uri=True) as original:
            with sqlite3.connect(destination / "data.db") as copied:
                original.backup(copied)
                for table, column in (("tasks", "description"), ("comments", "body")):
                    copied.execute(
                        f"UPDATE {table} SET {column} = replace({column}, ?, ?)",
                        ("/api/v1/plugins/tasks/", "/api/v1/plugins/tasks-plus/"),
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
    args = parser.parse_args()
    plugins = json.loads(subprocess.check_output(["bb", "plugin", "list", "--json"], text=True))["plugins"]
    if any(p["id"] in ("tasks", "tasks-plus") and p["enabled"] for p in plugins):
        parser.error("Disable Tasks and Tasks Plus before importing; import before installing Tasks Plus")
    import_tasks(args.data_dir / "plugins/tasks", args.data_dir / "plugins/tasks-plus")
    print("Copied Tasks database and attachments. The original storage is unchanged.")


if __name__ == "__main__":
    main()

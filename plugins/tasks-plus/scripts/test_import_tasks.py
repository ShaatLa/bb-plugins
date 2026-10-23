import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from import_tasks import import_tasks


class ImportTasksTest(unittest.TestCase):
    def test_preserves_source_rewrites_links_and_refuses_overwrite(self):
        with TemporaryDirectory() as temp:
            source = Path(temp) / "tasks"
            destination = Path(temp) / "tasks-plus"
            (source / "blobs/attachment").mkdir(parents=True)
            (source / "blobs/attachment/file.txt").write_text("attachment data")
            old = "/api/v1/plugins/tasks/http/attachments/download?attachmentId=1"
            with sqlite3.connect(source / "data.db") as db:
                db.execute("CREATE TABLE tasks (id TEXT, description TEXT)")
                db.execute("CREATE TABLE comments (body TEXT)")
                db.execute("INSERT INTO tasks VALUES ('stable-id', ?)", (old,))
                db.execute("INSERT INTO comments VALUES (?)", (old,))
            import_tasks(source, destination)
            with sqlite3.connect(destination / "data.db") as db:
                self.assertEqual(db.execute("SELECT id, description FROM tasks").fetchone(), ("stable-id", old.replace("/tasks/", "/tasks-plus/")))
                self.assertEqual(db.execute("SELECT body FROM comments").fetchone()[0], old.replace("/tasks/", "/tasks-plus/"))
            self.assertEqual((destination / "blobs/attachment/file.txt").read_text(), "attachment data")
            with sqlite3.connect(source / "data.db") as db:
                self.assertEqual(db.execute("SELECT description FROM tasks").fetchone()[0], old)
            with self.assertRaises(FileExistsError):
                import_tasks(source, destination)


if __name__ == "__main__":
    unittest.main()

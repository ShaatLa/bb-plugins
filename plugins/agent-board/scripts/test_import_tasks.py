import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from import_tasks import import_tasks


class ImportTasksTest(unittest.TestCase):
    def test_preserves_source_rewrites_links_and_refuses_overwrite(self):
        with TemporaryDirectory() as temp:
            source = Path(temp) / "tasks"
            destination = Path(temp) / "agent-board"
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
                self.assertEqual(db.execute("SELECT id, description FROM tasks").fetchone(), ("stable-id", old.replace("/tasks/", "/agent-board/")))
                self.assertEqual(db.execute("SELECT body FROM comments").fetchone()[0], old.replace("/tasks/", "/agent-board/"))
            self.assertEqual((destination / "blobs/attachment/file.txt").read_text(), "attachment data")
            with sqlite3.connect(source / "data.db") as db:
                self.assertEqual(db.execute("SELECT description FROM tasks").fetchone()[0], old)
            with self.assertRaises(FileExistsError):
                import_tasks(source, destination)


    def test_migrates_legacy_question_history_without_changing_answers_or_ids(self):
        with TemporaryDirectory() as temp:
            source = Path(temp) / "tasks-plus"
            source.mkdir()
            old = "/api/v1/plugins/tasks-plus/http/attachments/download?attachmentId=stable"
            payload = '{"answer":{"optionIds":["choice-1"],"otherText":null},"prompt":"' + old + '"}'
            with sqlite3.connect(source / "data.db") as db:
                db.execute("CREATE TABLE task_questions (id TEXT PRIMARY KEY, payload TEXT)")
                db.execute("INSERT INTO task_questions VALUES (?, ?)", ("question-1", payload))
            destination = Path(temp) / "agent-board"
            import_tasks(source, destination, "tasks-plus")
            with sqlite3.connect(destination / "data.db") as db:
                self.assertEqual(db.execute("SELECT id, payload FROM task_questions").fetchone(),
                                 ("question-1", payload.replace("/plugins/tasks-plus/", "/plugins/agent-board/")))
            with sqlite3.connect(source / "data.db") as db:
                self.assertEqual(db.execute("SELECT payload FROM task_questions").fetchone()[0], payload)
            self.assertEqual((destination / "data.db").stat().st_mode & 0o777, 0o600)
            rollback = Path(temp) / "rollback-tasks-plus"
            import_tasks(destination, rollback, "agent-board", "tasks-plus")
            with sqlite3.connect(rollback / "data.db") as db:
                self.assertEqual(db.execute("SELECT id, payload FROM task_questions").fetchone(), ("question-1", payload))


if __name__ == "__main__":
    unittest.main()

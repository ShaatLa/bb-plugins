# bb-plugins

## Public repository: neutral examples only

This repository is public. Commit messages, READMEs, docs, skills, tests and fixtures use neutral examples only:

- no names of private projects, customers or repositories the plugins are used with;
- no project task keys, real bb thread ids, project ids, run ids or other captured identifiers;
- no quotes of the owner or of project messages, and no captured real events or logs.

Use placeholders such as `proj_example`, `thr_example`, `EXA-1`, `example/ready-check` and `owner/repo`. When a change was prompted by a real incident, describe the behavior, not the incident. Existing history is not rewritten.

## Plugin settings: one field at a time

Agents keep full access to plugin settings, but read and change them one field at a time instead of writing whole objects. A global setting is a native field (`bb.settings.define`), so `bb plugin config <id>` lists it and `bb plugin config <id> set <key> <value>` / `unset <key>` change it. A per-project setting gets `bb <plugin> config get [<key>] --project <id>` and `bb <plugin> config set <key> <value> --project <id>`, plus RPC `config.get {projectId, key?}` and `config.set {projectId, key, value}`, which validate and return only that key. Existing whole-object calls keep working.

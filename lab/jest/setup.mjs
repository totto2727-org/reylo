// oxlint-disable-next-line rules/no-node-imports -- The Node integration fixture uses this built-in to exercise the host's real SQLite driver.
import { DatabaseSync } from "node:sqlite";
// oxlint-disable-next-line rules/no-node-imports -- The Node integration fixture uses this built-in to inspect or write files through the host filesystem.
import { unlinkSync } from "node:fs";

try { unlinkSync(new URL("lab.db", import.meta.url)); } catch {}
const db = new DatabaseSync(new URL("lab.db", import.meta.url).pathname);
db.exec(`create table users (id integer primary key, name text not null, email text, score real, avatar blob, created_at text not null default current_timestamp);
create unique index users_email on users(email);
create table posts (id integer primary key, user_id integer not null references users(id), title text not null, body text);
insert into users (name, email, score) values ('ada', 'ada@example.com', 1.5), ('bob', null, null);
insert into posts (user_id, title, body) values (1, 'hello', null);`);
db.close();

# PostgreSQL Connection and Project Run Guide

## 1) Check PostgreSQL install

```bash
psql --version
```

If this fails, install PostgreSQL (Homebrew):

```bash
brew install postgresql@15
```

## 2) Start PostgreSQL

```bash
pg_ctl -D /opt/homebrew/var/postgresql@15 -l /opt/homebrew/var/log/postgresql@15.log start
```

Verify it is running:

```bash
pg_isready
```

Expected output includes: `accepting connections`.

## 3) Environment variables for DB connection

Add these variables in `.env` (or export in shell):

```env
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=your_postgres_user
PGPASSWORD=your_postgres_password
PGDATABASE=postgres
```

Alternative: use a single `DATABASE_URL`:

```env
DATABASE_URL=postgresql://your_postgres_user:your_postgres_password@127.0.0.1:5432/postgres
```

## 4) Migrate existing SQLite data to PostgreSQL

The project includes a migration script that copies `bots` and `message_templates` from `data/config.sqlite` into PostgreSQL.

```bash
npm run migrate:sqlite-to-postgres
```

Note: this migration truncates and reloads `bots` and `message_templates` in PostgreSQL.

## 5) Install project dependencies

```bash
npm install
```

## 6) Run project

```bash
npm start
```

The bot and admin panel will now use PostgreSQL tables instead of SQLite.

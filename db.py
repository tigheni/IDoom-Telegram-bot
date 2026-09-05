import sqlite3
from pathlib import Path

DB_FILE = Path("idoom_bot.db")


def get_connection():
    connection = sqlite3.connect(DB_FILE)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with get_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                telegram_id INTEGER PRIMARY KEY,
                idoom_number TEXT NOT NULL,
                encrypted_password TEXT NOT NULL,
                expiration TEXT,
                last_notified_expiration TEXT
            )
            """
        )
        connection.commit()


def save_user(
    telegram_id,
    idoom_number,
    encrypted_password,
    expiration=None,
):
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO users (
                telegram_id,
                idoom_number,
                encrypted_password,
                expiration
            )
            VALUES (?, ?, ?, ?)

            ON CONFLICT(telegram_id)
            DO UPDATE SET
                idoom_number = excluded.idoom_number,
                encrypted_password = excluded.encrypted_password,
                expiration = excluded.expiration,
                last_notified_expiration = NULL
            """,
            (
                telegram_id,
                idoom_number,
                encrypted_password,
                expiration,
            ),
        )
        connection.commit()


def get_user(telegram_id):
    with get_connection() as connection:
        row = connection.execute(
            "SELECT * FROM users WHERE telegram_id = ?",
            (telegram_id,),
        ).fetchone()

    return row


def get_all_users():
    with get_connection() as connection:
        return connection.execute(
            "SELECT * FROM users"
        ).fetchall()


def set_expiration(telegram_id, expiration):
    with get_connection() as connection:
        connection.execute(
            """
            UPDATE users
            SET expiration = ?
            WHERE telegram_id = ?
            """,
            (expiration, telegram_id),
        )
        connection.commit()


def mark_notified(telegram_id, expiration):
    with get_connection() as connection:
        connection.execute(
            """
            UPDATE users
            SET last_notified_expiration = ?
            WHERE telegram_id = ?
            """,
            (expiration, telegram_id),
        )
        connection.commit()
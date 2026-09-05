from datetime import datetime
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ConversationHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from at_client import get_expiration_date
from crypto import encrypt_password, decrypt_password
from db import (
    get_all_users,
    get_connection,
    get_user,
    init_db,
    mark_notified,
    save_user,
)

import os


ALGERIA_TZ = ZoneInfo("Africa/Algiers")

BOT_TOKEN = os.getenv("BOT_TOKEN")

CHECK_INTERVAL = 5 * 60
ALERT_SECONDS = 5 * 60 * 60

ENTER_ND, ENTER_PASSWORD = range(2)


async def start(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    user = get_user(update.effective_chat.id)

    if user:
        await update.message.reply_text(
            "👋 You're already registered.\n\n"
            "/status - Check subscription\n"
            "/check - Check now\n"
            "/setup - Change your AT account"
        )
        return ConversationHandler.END

    await update.message.reply_text(
        "👋 Welcome to IDoom Fibre Bot!\n\n"
        "Send your IDoom Fibre number:"
    )

    return ENTER_ND

async def remove_account(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    telegram_id = update.effective_chat.id

    with get_connection() as connection:
        cursor = connection.execute(
            "DELETE FROM users WHERE telegram_id = ?",
            (telegram_id,),
        )

        deleted = cursor.rowcount

        connection.commit()

    if deleted:
        await update.message.reply_text(
            "✅ Your IDoom account has been removed."
        )
    else:
        await update.message.reply_text(
            "ℹ️ You don't have a registered IDoom account."
        )

async def receive_nd(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    nd = update.message.text.strip()

    if not nd.isdigit():
        await update.message.reply_text(
            "❌ Please enter a valid number."
        )
        return ENTER_ND

    context.user_data["nd"] = nd

    await update.message.reply_text(
        "Now send your Algérie Télécom password."
    )

    return ENTER_PASSWORD


async def receive_password(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    password = update.message.text.strip()

    # Delete the password message from Telegram chat
    try:
        await update.message.delete()
    except Exception as error:
        print(f"Could not delete password message: {error}")

    nd = context.user_data.get("nd")

    if not nd:
        await update.message.reply_text(
            "❌ Your IDoom number is missing. Please use /start again."
        )
        context.user_data.clear()
        return ConversationHandler.END

    await update.message.reply_text(
        "🔐 Checking your Algérie Télécom account..."
    )

    try:
        expiration = get_expiration_date(
            nd,
            password,
        )

        encrypted_password = encrypt_password(password)

        save_user(
            telegram_id=update.effective_chat.id,
            idoom_number=nd,
            encrypted_password=encrypted_password,
            expiration=expiration.isoformat(),
        )

        context.user_data.clear()

        await update.message.reply_text(
            "✅ Account successfully connected!\n\n"
            f"📅 Expiration: "
            f"{expiration.strftime('%d-%m-%Y %H:%M')}\n\n"
            "I will automatically notify you "
            "when 5 hours remain."
        )

    except Exception as error:
        print(
            f"Registration error for "
            f"{update.effective_chat.id}: {error}"
        )

        context.user_data.clear()

        await update.message.reply_text(
            "❌ I couldn't log into your Algérie Télécom account.\n\n"
            "Check your IDoom number and password, then try /setup again."
        )

    return ConversationHandler.END

async def cancel(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    context.user_data.clear()

    await update.message.reply_text(
        "❌ Setup cancelled."
    )

    return ConversationHandler.END


async def setup(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    await update.message.reply_text(
        "🔧 Let's set up your account.\n\n"
        "Send your IDoom Fibre number:"
    )

    return ENTER_ND


async def status(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    user = get_user(update.effective_chat.id)

    if not user:
        await update.message.reply_text(
            "❌ You are not registered.\n\n"
            "Use /start"
        )
        return

    await update.message.reply_text(
        "🔎 Checking your subscription..."
    )

    try:
        password = decrypt_password(
            user["encrypted_password"]
        )

        expiration = get_expiration_date(
            user["idoom_number"],
            password,
        )

        now = datetime.now(ALGERIA_TZ)
        remaining = expiration - now
        seconds = int(
            remaining.total_seconds()
        )

        if seconds <= 0:
            await update.message.reply_text(
                "🔴 Your subscription has expired."
            )
            return

        days, remainder = divmod(
            seconds,
            86400,
        )
        hours, remainder = divmod(
            remainder,
            3600,
        )
        minutes, _ = divmod(
            remainder,
            60,
        )

        await update.message.reply_text(
            f"✅ Subscription status\n\n"
            f"📅 Expires: "
            f"{expiration.strftime('%d-%m-%Y %H:%M')}\n"
            f"⏳ Remaining: "
            f"{days}d {hours}h {minutes}m"
        )

    except Exception as error:
        print(
            f"Status error for "
            f"{update.effective_chat.id}: {error}"
        )

        await update.message.reply_text(
            "❌ Couldn't check your subscription."
        )


async def check_now(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    await status(update, context)


async def automatic_check(
    context: ContextTypes.DEFAULT_TYPE,
):
    users = get_all_users()

    for user in users:
        telegram_id = user["telegram_id"]

        try:
            password = decrypt_password(
                user["encrypted_password"]
            )

            expiration = get_expiration_date(
                user["idoom_number"],
                password,
            )

            now = datetime.now(ALGERIA_TZ)
            remaining = expiration - now
            seconds = remaining.total_seconds()

            print(
                f"[CHECK] {telegram_id} | "
                f"Expires: "
                f"{expiration:%Y-%m-%d %H:%M:%S} | "
                f"Remaining: {remaining}"
            )

            if seconds <= 0:
                continue

            if seconds <= ALERT_SECONDS:
                expiration_key = (
                    expiration.isoformat()
                )

                if (
                    user["last_notified_expiration"]
                    == expiration_key
                ):
                    continue

                total_seconds = int(seconds)

                hours, remainder = divmod(
                    total_seconds,
                    3600,
                )
                minutes, _ = divmod(
                    remainder,
                    60,
                )

                await context.bot.send_message(
                    chat_id=telegram_id,
                    text=(
                        "⚠️ IDoom Fibre subscription alert!\n\n"
                        f"Your subscription expires in "
                        f"approximately {hours}h {minutes}m.\n\n"
                        f"📅 Expiration: "
                        f"{expiration.strftime('%d-%m-%Y %H:%M')}"
                    ),
                )

                mark_notified(
                    telegram_id,
                    expiration_key,
                )

                print(
                    f"[ALERT] Sent to {telegram_id}"
                )

        except Exception as error:
            print(
                f"[CHECK ERROR] "
                f"{telegram_id}: {error}"
            )


async def error_handler(
    update: object,
    context: ContextTypes.DEFAULT_TYPE,
):
    print(
        f"Unhandled error: {context.error}"
    )


def main():
    if not BOT_TOKEN:
        raise RuntimeError(
            "BOT_TOKEN is missing from .env"
        )

    init_db()

    application = (
        Application.builder()
        .token(BOT_TOKEN)
        .build()
    )

    setup_handler = ConversationHandler(
        entry_points=[
            CommandHandler("start", start),
            CommandHandler("setup", setup),
        ],
        states={
            ENTER_ND: [
                MessageHandler(
                    filters.TEXT
                    & ~filters.COMMAND,
                    receive_nd,
                )
            ],
            ENTER_PASSWORD: [
                MessageHandler(
                    filters.TEXT
                    & ~filters.COMMAND,
                    receive_password,
                )
            ],
        },
        fallbacks=[
            CommandHandler("cancel", cancel)
        ],
    )

    application.add_handler(setup_handler)
    application.add_handler(
        CommandHandler("status", status)
    )
    application.add_handler(
        CommandHandler("check", check_now)
    )

    application.add_error_handler(
        error_handler
    )

    application.job_queue.run_repeating(
        automatic_check,
        interval=CHECK_INTERVAL,
        first=10,
    )

    application.add_handler(
    CommandHandler("remove", remove_account)
)

    print("Bot is running...")
    print("Automatic checker: every 5 minutes")

    application.run_polling()


if __name__ == "__main__":
    main()
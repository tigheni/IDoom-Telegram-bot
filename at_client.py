import os
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()

BASE_URL = "https://client.at.dz"
ALGERIA_TZ = ZoneInfo("Africa/Algiers")


def get_expiration_date(nd: str, password: str):
    with httpx.Client(
        base_url=BASE_URL,
        follow_redirects=True,
        timeout=20.0,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) "
                "AppleWebKit/537.36 "
                "Chrome/149 Safari/537.36"
            )
        },
    ) as client:

        # Get login page and CSRF token
        login_page = client.get("/en/login")
        login_page.raise_for_status()

        soup = BeautifulSoup(
            login_page.text,
            "html.parser",
        )

        token_input = soup.find(
            "input",
            {"name": "_token"},
        )

        if not token_input or not token_input.get("value"):
            raise RuntimeError(
                "Could not find CSRF token"
            )

        csrf_token = token_input["value"]

        # Login
        response = client.post(
            "/en/login",
            data={
                "_token": csrf_token,
                "nd": nd,
                "password": password,
            },
        )

        response.raise_for_status()

        # Get customer home page
        home = client.get("/en/accueil")
        home.raise_for_status()

        soup = BeautifulSoup(
            home.text,
            "html.parser",
        )

        label = soup.find(
            string=re.compile(
                r"Your internet subscription expires on",
                re.IGNORECASE,
            )
        )

        if not label:
            raise RuntimeError(
                "Could not find subscription expiration"
            )

        parent = label.parent
        value_element = parent.find_next_sibling()

        if not value_element:
            raise RuntimeError(
                "Could not find expiration value"
            )

        text = value_element.get_text(
            " ",
            strip=True,
        )

        match = re.search(
            r"\b(\d{2}-\d{2}-\d{4})\b",
            text,
        )

        if not match:
            raise RuntimeError(
                f"Could not extract expiration date from: {text}"
            )

        # AT displays the last valid calendar day.
        expiration = datetime.strptime(
            match.group(1),
            "%d-%m-%Y",
        ).replace(tzinfo=ALGERIA_TZ)

        # Internet is cut when the next day begins.
        expiration += timedelta(days=1)

        return expiration
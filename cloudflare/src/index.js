const AT_BASE_URL = 'https://client.at.dz';
const ALGERIA_TIME_ZONE = 'Africa/Algiers';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

// ============================================================
// Telegram
// ============================================================

async function telegramRequest(env, method, body) {
	const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});

	const data = await response.json();

	if (!response.ok || !data.ok) {
		throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(data)}`);
	}

	return data.result;
}

async function sendTelegramMessage(env, chatId, text) {
	return telegramRequest(env, 'sendMessage', {
		chat_id: chatId,
		text,
	});
}

async function deleteTelegramMessage(env, chatId, messageId) {
	try {
		await telegramRequest(env, 'deleteMessage', {
			chat_id: chatId,
			message_id: messageId,
		});
	} catch (error) {
		console.log(`Could not delete message ${messageId}: ${error.message}`);
	}
}

// ============================================================
// Base64 helpers
// ============================================================

function bytesToBase64(bytes) {
	let binary = '';

	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary);
}

function base64ToBytes(value) {
	const binary = atob(value);

	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}

	return bytes;
}

// ============================================================
// Password encryption
// AES-256-GCM using a key derived from ENCRYPTION_KEY
// ============================================================

async function getEncryptionKey(env) {
	const encoder = new TextEncoder();

	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.ENCRYPTION_KEY));

	return crypto.subtle.importKey(
		'raw',
		digest,
		{
			name: 'AES-GCM',
		},
		false,
		['encrypt', 'decrypt'],
	);
}

async function encryptPassword(env, password) {
	const key = await getEncryptionKey(env);

	const iv = crypto.getRandomValues(new Uint8Array(12));

	const encoder = new TextEncoder();

	const encrypted = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv,
		},
		key,
		encoder.encode(password),
	);

	return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

async function decryptPassword(env, encryptedValue) {
	const [ivBase64, encryptedBase64] = encryptedValue.split('.');

	if (!ivBase64 || !encryptedBase64) {
		throw new Error('Invalid encrypted password format');
	}

	const key = await getEncryptionKey(env);

	const iv = base64ToBytes(ivBase64);
	const encrypted = base64ToBytes(encryptedBase64);

	const decrypted = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv,
		},
		key,
		encrypted,
	);

	return new TextDecoder().decode(decrypted);
}

// ============================================================
// Algérie Télécom cookies
// ============================================================

function getSetCookies(response) {
	if (typeof response.headers.getSetCookie === 'function') {
		return response.headers.getSetCookie();
	}

	if (typeof response.headers.getAll === 'function') {
		return response.headers.getAll('Set-Cookie');
	}

	const single = response.headers.get('Set-Cookie');

	return single ? [single] : [];
}

function cookiePairsFromResponse(response) {
	return getSetCookies(response)
		.map((cookie) => cookie.split(';')[0])
		.filter(Boolean);
}

function mergeCookies(...cookieLists) {
	const cookies = new Map();

	for (const list of cookieLists) {
		for (const cookie of list) {
			const separator = cookie.indexOf('=');

			if (separator === -1) {
				continue;
			}

			const name = cookie.slice(0, separator);

			cookies.set(name, cookie);
		}
	}

	return Array.from(cookies.values()).join('; ');
}

// ============================================================
// Algérie Télécom login + expiry
// ============================================================

function extractCsrfToken(html) {
	const match = html.match(/<input[^>]+name=["']_token["'][^>]+value=["']([^"']+)["']/i);

	if (!match) {
		throw new Error('Could not find Algérie Télécom CSRF token');
	}

	return match[1];
}

function extractDisplayedExpiration(html) {
	const labelRegex = /Your internet subscription expires on\s*:/i;

	const labelMatch = html.match(labelRegex);

	if (!labelMatch) {
		throw new Error('Could not find subscription expiration label');
	}

	const afterLabel = html.slice(labelMatch.index + labelMatch[0].length);

	const dateMatch = afterLabel.match(/\b(\d{2})-(\d{2})-(\d{4})\b/);

	if (!dateMatch) {
		throw new Error('Could not find subscription expiration date');
	}

	return {
		day: Number(dateMatch[1]),
		month: Number(dateMatch[2]),
		year: Number(dateMatch[3]),
	};
}

/*
 * Algérie Télécom displays the LAST VALID CALENDAR DAY.
 *
 * Example:
 *
 * displayed: 04-09-2026
 * cutoff:    05-09-2026 00:00 Africa/Algiers
 *
 * Algeria is UTC+1, so:
 *
 * 05-09-2026 00:00 Algeria
 * =
 * 04-09-2026 23:00 UTC
 */
function expirationDateToUtc({ day, month, year }) {
	return new Date(Date.UTC(year, month - 1, day + 1, -1, 0, 0, 0));
}

async function getAtExpiration(nd, password) {
	// ----------------------------------------------------------
	// 1. GET login page
	// ----------------------------------------------------------

	const loginPage = await fetch(`${AT_BASE_URL}/en/login`, {
		method: 'GET',
		redirect: 'manual',
		headers: {
			'User-Agent': 'Mozilla/5.0 (compatible; IDoomBot/1.0)',
		},
	});

	if (!loginPage.ok && loginPage.status !== 302) {
		throw new Error(`AT login page failed: ${loginPage.status}`);
	}

	const loginHtml = await loginPage.text();

	const csrfToken = extractCsrfToken(loginHtml);

	const loginCookies = cookiePairsFromResponse(loginPage);

	// ----------------------------------------------------------
	// 2. POST login
	// ----------------------------------------------------------

	const body = new URLSearchParams();

	body.set('_token', csrfToken);
	body.set('nd', nd);
	body.set('password', password);

	const loginResponse = await fetch(`${AT_BASE_URL}/en/login`, {
		method: 'POST',
		redirect: 'manual',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'User-Agent': 'Mozilla/5.0 (compatible; IDoomBot/1.0)',
			Cookie: mergeCookies(loginCookies),
		},
		body,
	});

	if (loginResponse.status !== 301 && loginResponse.status !== 302 && loginResponse.status !== 303) {
		const loginText = await loginResponse.text();

		throw new Error(`Algérie Télécom login failed: ` + `${loginResponse.status} ` + loginText.slice(0, 300));
	}

	const postLoginCookies = cookiePairsFromResponse(loginResponse);

	const cookies = mergeCookies(loginCookies, postLoginCookies);

	// ----------------------------------------------------------
	// 3. GET customer home page
	// ----------------------------------------------------------

	const homeResponse = await fetch(`${AT_BASE_URL}/en/accueil`, {
		method: 'GET',
		redirect: 'manual',
		headers: {
			'User-Agent': 'Mozilla/5.0 (compatible; IDoomBot/1.0)',
			Cookie: cookies,
		},
	});

	if (homeResponse.status !== 200) {
		const homeText = await homeResponse.text();

		throw new Error(`Could not access AT customer page: ` + `${homeResponse.status} ` + homeText.slice(0, 300));
	}

	const html = await homeResponse.text();

	const displayedExpiration = extractDisplayedExpiration(html);

	return expirationDateToUtc(displayedExpiration);
}

// ============================================================
// Formatting
// ============================================================

function formatAlgeriaDate(date) {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: ALGERIA_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).format(date);
}

function formatRemaining(milliseconds) {
	const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000));

	const days = Math.floor(totalMinutes / 1440);

	const hours = Math.floor((totalMinutes % 1440) / 60);

	const minutes = totalMinutes % 60;

	return {
		days,
		hours,
		minutes,
	};
}

// ============================================================
// D1 helpers
// ============================================================

async function getUser(env, telegramId) {
	return env.DB.prepare(
		`SELECT *
       FROM users
       WHERE telegram_id = ?`,
	)
		.bind(String(telegramId))
		.first();
}

async function getAllUsers(env) {
	const result = await env.DB.prepare(
		`SELECT *
       FROM users`,
	).all();

	return result.results || [];
}

async function saveUser(env, telegramId, nd, encryptedPassword, expiration) {
	const now = new Date().toISOString();

	await env.DB.prepare(
		`INSERT INTO users (
        telegram_id,
        idoom_number,
        encrypted_password,
        expiration,
        last_notified_expiration,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?)

      ON CONFLICT(telegram_id)
      DO UPDATE SET
        idoom_number = excluded.idoom_number,
        encrypted_password = excluded.encrypted_password,
        expiration = excluded.expiration,
        last_notified_expiration = NULL,
        updated_at = excluded.updated_at`,
	)
		.bind(String(telegramId), nd, encryptedPassword, expiration, now, now)
		.run();
}

async function updateExpiration(env, telegramId, expiration) {
	await env.DB.prepare(
		`UPDATE users
       SET expiration = ?,
           updated_at = ?
       WHERE telegram_id = ?`,
	)
		.bind(expiration, new Date().toISOString(), String(telegramId))
		.run();
}

async function markNotified(env, telegramId, expiration) {
	await env.DB.prepare(
		`UPDATE users
       SET last_notified_expiration = ?,
           updated_at = ?
       WHERE telegram_id = ?`,
	)
		.bind(expiration, new Date().toISOString(), String(telegramId))
		.run();
}

async function deleteUser(env, telegramId) {
	await env.DB.batch([
		env.DB.prepare(
			`DELETE FROM users
         WHERE telegram_id = ?`,
		).bind(String(telegramId)),

		env.DB.prepare(
			`DELETE FROM setup_sessions
         WHERE telegram_id = ?`,
		).bind(String(telegramId)),
	]);
}

async function getSetupSession(env, telegramId) {
	return env.DB.prepare(
		`SELECT *
       FROM setup_sessions
       WHERE telegram_id = ?`,
	)
		.bind(String(telegramId))
		.first();
}

async function saveSetupSession(env, telegramId, nd) {
	console.log(`[DB] Saving setup session for ${telegramId}`);

	await env.DB.prepare(
		`INSERT INTO setup_sessions (
        telegram_id,
        idoom_number
      )
      VALUES (?, ?)

      ON CONFLICT(telegram_id)
      DO UPDATE SET
        idoom_number = excluded.idoom_number,
        created_at = CURRENT_TIMESTAMP`,
	)
		.bind(String(telegramId), nd)
		.run();

	console.log(`[DB] Setup session saved for ${telegramId}`);
}

async function deleteSetupSession(env, telegramId) {
	await env.DB.prepare(
		`DELETE FROM setup_sessions
       WHERE telegram_id = ?`,
	)
		.bind(String(telegramId))
		.run();
}

// ============================================================
// Bot commands
// ============================================================

async function handleStart(env, message) {
	const chatId = message.chat.id;

	console.log(`[START] Telegram user: ${chatId}`);

	const user = await getUser(env, chatId);

	console.log(`[START] Existing user: ${user ? 'YES' : 'NO'}`);

	if (user) {
		await sendTelegramMessage(
			env,
			chatId,
			"👋 You're already registered.\n\n" +
				'/status - Check subscription\n' +
				'/check - Check now\n' +
				'/setup - Change your AT account\n' +
				'/remove - Remove your account',
		);

		return;
	}

	await saveSetupSession(env, chatId, '');

	console.log(`[START] Setup session created for ${chatId}`);

	await sendTelegramMessage(env, chatId, '👋 Welcome to IDoom Fibre Bot!\n\n' + 'Send your IDoom Fibre number:');
}

async function startSetup(env, chatId) {
	await saveSetupSession(env, chatId, '');

	await sendTelegramMessage(env, chatId, '🔧 Account setup\n\n' + 'Send your IDoom Fibre number:');
}

async function handleSetupNumber(env, message) {
	const chatId = message.chat.id;

	const nd = String(message.text || '').trim();

	if (!/^\d+$/.test(nd)) {
		await sendTelegramMessage(env, chatId, '❌ Please enter a valid IDoom number.');

		return;
	}

	await saveSetupSession(env, chatId, nd);

	await sendTelegramMessage(
		env,
		chatId,
		'Now send your Algérie Télécom password.\n\n' + '🔐 Your password message will be deleted ' + 'after I receive it.',
	);
}

async function handlePassword(env, message) {
	const chatId = message.chat.id;

	const session = await getSetupSession(env, chatId);

	if (!session || !session.idoom_number) {
		await sendTelegramMessage(env, chatId, '❌ Setup session not found.\n\n' + 'Use /start or /setup.');

		return;
	}

	const password = String(message.text || '');

	// Remove the password message from Telegram.
	await deleteTelegramMessage(env, chatId, message.message_id);

	await sendTelegramMessage(env, chatId, '🔐 Checking your Algérie Télécom account...');

	try {
		const expiration = await getAtExpiration(session.idoom_number, password);

		const encryptedPassword = await encryptPassword(env, password);

		await saveUser(env, chatId, session.idoom_number, encryptedPassword, expiration.toISOString());

		await deleteSetupSession(env, chatId);

		await sendTelegramMessage(
			env,
			chatId,
			'✅ Account successfully connected!\n\n' +
				`📅 Expiration: ${formatAlgeriaDate(expiration)}\n\n` +
				'I will automatically notify you ' +
				'when 5 hours remain.',
		);
	} catch (error) {
		console.log(`Registration error for ${chatId}:`, error.message);

		await deleteSetupSession(env, chatId);

		await sendTelegramMessage(
			env,
			chatId,
			"❌ I couldn't log into your " +
				'Algérie Télécom account.\n\n' +
				'Check your IDoom number and password, ' +
				'then use /setup to try again.',
		);
	}
}

async function sendStatus(env, chatId) {
	const user = await getUser(env, chatId);

	if (!user) {
		await sendTelegramMessage(env, chatId, '❌ You are not registered.\n\n' + 'Use /start.');

		return;
	}

	await sendTelegramMessage(env, chatId, '🔎 Checking your subscription...');

	try {
		const password = await decryptPassword(env, user.encrypted_password);

		const expiration = await getAtExpiration(user.idoom_number, password);

		await updateExpiration(env, chatId, expiration.toISOString());

		const now = new Date();

		const remaining = expiration.getTime() - now.getTime();

		if (remaining <= 0) {
			await sendTelegramMessage(env, chatId, '🔴 Your IDoom Fibre subscription has expired.');

			return;
		}

		const { days, hours, minutes } = formatRemaining(remaining);

		await sendTelegramMessage(
			env,
			chatId,
			'✅ Subscription status\n\n' + `📅 Expires: ${formatAlgeriaDate(expiration)}\n` + `⏳ Remaining: ${days}d ${hours}h ${minutes}m`,
		);
	} catch (error) {
		console.log(`Status error for ${chatId}:`, error.message);

		await sendTelegramMessage(env, chatId, "❌ I couldn't check your subscription.");
	}
}

async function removeAccount(env, chatId) {
	await deleteUser(env, chatId);

	await sendTelegramMessage(env, chatId, '✅ Your IDoom account and stored ' + 'credentials have been removed.');
}

// ============================================================
// Automatic 5-hour check
// ============================================================

async function checkUserAutomatically(env, user) {
	const telegramId = String(user.telegram_id);

	try {
		const password = await decryptPassword(env, user.encrypted_password);

		const expiration = await getAtExpiration(user.idoom_number, password);

		const expirationIso = expiration.toISOString();

		// This is important for renewals:
		//
		// If AT changes:
		//
		// old expiry → new expiry
		//
		// the new ISO value is different and therefore
		// can trigger a new 5-hour alert.
		await updateExpiration(env, telegramId, expirationIso);

		const now = Date.now();

		const remaining = expiration.getTime() - now;

		console.log(
			`[CHECK] ${telegramId} | ` + `Expires: ${expiration.toISOString()} | ` + `Remaining: ${Math.round(remaining / 60000)} minutes`,
		);

		if (remaining <= 0) {
			return;
		}

		if (remaining > FIVE_HOURS_MS) {
			return;
		}

		if (user.last_notified_expiration === expirationIso) {
			console.log(`[CHECK] ${telegramId} already notified.`);

			return;
		}

		const { hours, minutes } = formatRemaining(remaining);

		await sendTelegramMessage(
			env,
			telegramId,
			'⚠️ IDoom Fibre subscription alert!\n\n' +
				`Your subscription expires in approximately ` +
				`${hours}h ${minutes}m.\n\n` +
				`📅 Expiration: ` +
				`${formatAlgeriaDate(expiration)}`,
		);

		await markNotified(env, telegramId, expirationIso);

		console.log(`[ALERT] Sent to ${telegramId}`);
	} catch (error) {
		console.log(`[CHECK ERROR] ${telegramId}:`, error.message);
	}
}

// ============================================================
// Scheduled worker
// ============================================================

async function runAutomaticChecks(env) {
	const users = await getAllUsers(env);

	console.log(`[CRON] Checking ${users.length} user(s)`);

	for (const user of users) {
		await checkUserAutomatically(env, user);
	}
}

// ============================================================
// Worker entry point
// ============================================================

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// Health check
		if (request.method === 'GET' && url.pathname === '/') {
			return new Response('IDoom Bot is running!');
		}

		// Telegram webhook
		if (request.method === 'POST' && url.pathname === '/telegram') {
			let update;

			try {
				update = await request.json();
			} catch {
				return new Response('Invalid JSON', { status: 400 });
			}

			const message = update.message;

			if (!message?.chat?.id) {
				return new Response('OK');
			}

			const chatId = message.chat.id;

			const text = String(message.text || '').trim();

			// ------------------------------------------------------
			// Commands
			// ------------------------------------------------------
			if (text === '/start') {
				await handleStart(env, message);

				return new Response('OK');
			}
			if (text === '/setup') {
				await startSetup(env, chatId);

				return new Response('OK');
			}

			if (text === '/status') {
				ctx.waitUntil(sendStatus(env, chatId));

				return new Response('OK');
			}

			if (text === '/check') {
				ctx.waitUntil(sendStatus(env, chatId));

				return new Response('OK');
			}

			if (text === '/remove') {
				ctx.waitUntil(removeAccount(env, chatId));

				return new Response('OK');
			}

			if (text === '/cancel') {
				ctx.waitUntil(deleteSetupSession(env, chatId).then(() => sendTelegramMessage(env, chatId, '❌ Setup cancelled.')));

				return new Response('OK');
			}

			// ------------------------------------------------------
			// Setup conversation
			// ------------------------------------------------------
			if (message.text) {
				const session = await getSetupSession(env, chatId);

				if (session) {
					if (!session.idoom_number) {
						await handleSetupNumber(env, message);

						return new Response('OK');
					}

					ctx.waitUntil(handlePassword(env, message));

					return new Response('OK');
				}
			}

			return new Response('OK');
		}

		return new Response('Not Found', { status: 404 });
	},

	async scheduled(controller, env, ctx) {
		ctx.waitUntil(runAutomaticChecks(env));
	},
};

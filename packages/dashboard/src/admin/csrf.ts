import { randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { AppError, ERROR_CODES } from '@ai-manager/shared';

/**
 * CSRF 対策(要件 v0.3 §5.1: POST フォームには CSRF トークンを必須とする)。
 *
 * セッションレス構成のため二重送信クッキー方式を採用する:
 *   1. GET 時にランダムトークンを Set-Cookie(SameSite=Strict / Secure / Path=/)し、
 *      同じ値を各フォームの hidden input に埋め込む
 *   2. POST 時にクッキーと hidden input の一致を検証する
 * SameSite=Strict によりクッキーはクロスサイトのリクエストに載らず、
 * 外部サイトからのフォーム送信はトークン不一致(欠落)で拒否される。
 * hidden input と突き合わせる方式のため HttpOnly は付けない。
 *
 * クッキー名は __Host- プレフィックス付き(cookie-tossing 耐性)。
 * __Host- の要件により属性は Secure / Path=/ 固定・Domain 指定なしとする。
 * Secure 属性のため plain HTTP では動作しないが、全デプロイ経路が HTTPS のため許容する。
 */

export const CSRF_COOKIE = '__Host-aim_csrf';
export const CSRF_FIELD = '_csrf';

/** randomBytes(32) の hex 表現(64 文字)のみを有効なトークンとして扱う */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Cookie ヘッダーを名前→値のマップに分解する(値のデコードはしない: トークンは hex のみ)。 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined || header === '') return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    cookies[name] = part.slice(eq + 1).trim();
  }
  return cookies;
}

/**
 * GET 時: 有効な CSRF クッキーがあればそれを再利用し(複数タブでの同時編集を壊さない)、
 * なければ新規発行して Set-Cookie する。戻り値をフォームの hidden input に埋め込むこと。
 */
export function ensureCsrfToken(req: http.IncomingMessage, res: http.ServerResponse): string {
  const existing = parseCookies(req.headers.cookie)[CSRF_COOKIE];
  if (existing !== undefined && TOKEN_PATTERN.test(existing)) return existing;
  const token = randomBytes(32).toString('hex');
  // appendHeader: 他処理が設定済みの Set-Cookie を上書きせず追記する
  res.appendHeader('set-cookie', `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict; Secure`);
  return token;
}

/** POST 時: クッキーと hidden input(_csrf)の一致を検証する。失敗は AIM-6003(403)。 */
export function verifyCsrfToken(cookieHeader: string | undefined, form: URLSearchParams): void {
  const cookieToken = parseCookies(cookieHeader)[CSRF_COOKIE];
  const formToken = form.get(CSRF_FIELD);
  if (
    cookieToken === undefined ||
    !TOKEN_PATTERN.test(cookieToken) ||
    formToken === null ||
    !TOKEN_PATTERN.test(formToken)
  ) {
    throw new AppError(
      ERROR_CODES.CSRF_TOKEN_INVALID,
      'CSRF トークンがありません。ページを再読み込みしてからやり直してください',
      { status: 403 },
    );
  }
  // 両者とも 64 文字の hex であることを検証済みのため長さは常に一致する
  if (!timingSafeEqual(Buffer.from(cookieToken), Buffer.from(formToken))) {
    throw new AppError(
      ERROR_CODES.CSRF_TOKEN_INVALID,
      'CSRF トークンが一致しません。ページを再読み込みしてからやり直してください',
      { status: 403 },
    );
  }
}

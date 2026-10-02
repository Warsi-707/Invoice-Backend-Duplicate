import crypto from 'node:crypto';
import 'dotenv/config';

const JWT_ALGORITHM = 'HS256';
const JWT_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_JWT_SECRET = 'uBLRAJkq+79Ooa+82Czf7l2fNMTnEaRtC1y0Sqlc4kk=';

function getJwtSecret(overrideSecret) {
  return overrideSecret || process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(input, secret) {
  return crypto.createHmac('sha256', secret).update(input).digest('base64url');
}

export function createToken(payload, customSecret) {
  const secret = getJwtSecret(customSecret);
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: JWT_ALGORITHM, typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify({ ...payload, iat: now, exp: now + JWT_TTL_SECONDS }));
  const content = `${header}.${body}`;
  return `${content}.${sign(content, secret)}`;
}

export function verifyToken(token, customSecret) {
  const secret = getJwtSecret(customSecret);
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token.');

  const [header, body, signature] = parts;
  const expected = sign(`${header}.${body}`, secret);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    throw new Error('Invalid token signature.');
  }

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired.');
  }

  return payload;
}

export function authenticateToken(req, res, next) {
  const authorization = req.headers.authorization || '';
  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Authentication token is required.' });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ message: err.message || 'Invalid authentication token.' });
  }
}

'use strict';
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(8).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex');
}
function verifyPassword(password, stored) {
  const [salt, expected] = (stored || '').split(':');
  if (!salt || !expected) return false;
  return crypto.scryptSync(password, salt, 32).toString('hex') === expected;
}
function newApiKey(prefix) { return `${prefix || 'key'}_${crypto.randomBytes(18).toString('base64url')}`; }

module.exports = { hashPassword, verifyPassword, newApiKey };

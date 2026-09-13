'use strict';
// Same provider-abstraction pattern as the AI-testing app's payment.js, but
// this app also needs recurring subscriptions, which is a different API
// shape per provider (Stripe Subscriptions / PayPal Subscriptions) than a
// pure one-time Checkout Session or Order — hence a separate module rather
// than sharing one file between the two apps. NOTE: the live Stripe/PayPal
// code below is implemented against each provider's documented API shape but
// has not been exercised against a real sandbox in this environment —
// MOCK_MODE is the path that's actually been run end-to-end here. Test
// against real sandbox keys before taking any real payment.
const MOCK_MODE = (process.env.MOCK_MODE || 'false').toLowerCase() === 'true';
const PROVIDER = (process.env.PAYMENT_PROVIDER || 'stripe').toLowerCase();
const SUBSCRIPTION_PRICE_CENTS = parseInt(process.env.SUBSCRIPTION_PRICE_CENTS, 10) || 4900; // $49/mo default
const CATALOG_SUBMISSION_FEE_CENTS = parseInt(process.env.CATALOG_SUBMISSION_FEE_CENTS, 10) || 2500; // $25 default

function paypalBase() { return process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
async function paypalToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${paypalBase()}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  return (await res.json()).access_token;
}

// ---- one-time payments (token purchases, catalog submission fee) ----
async function startOneTimePayment({ amountCents, description, returnBaseUrl, meta }) {
  if (MOCK_MODE) return { mock: true, providerRef: 'mock_' + Math.random().toString(36).slice(2) };
  const successUrl = `${returnBaseUrl}#/return?status=success&kind=${meta.kind}&ref=${meta.ref}`;
  const cancelUrl = `${returnBaseUrl}#/return?status=cancel&kind=${meta.kind}&ref=${meta.ref}`;

  if (PROVIDER === 'stripe') {
    const stripe = require('stripe')(process.env.STRIPE_API_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price_data: { currency: 'usd', unit_amount: amountCents, product_data: { name: description } }, quantity: 1 }],
      success_url: successUrl, cancel_url: cancelUrl, metadata: meta
    });
    return { redirectUrl: session.url, providerRef: session.id };
  }
  if (PROVIDER === 'paypal') {
    const token = await paypalToken();
    const orderRes = await fetch(`${paypalBase()}/v2/checkout/orders`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: (amountCents / 100).toFixed(2) }, description, custom_id: meta.ref }], application_context: { return_url: successUrl, cancel_url: cancelUrl } })
    });
    const order = await orderRes.json();
    const approve = (order.links || []).find((l) => l.rel === 'approve');
    return { redirectUrl: approve?.href, providerRef: order.id };
  }
  throw new Error(`Unknown PAYMENT_PROVIDER "${PROVIDER}".`);
}

async function confirmOneTimePayment({ providerRef }) {
  if (MOCK_MODE) return { paid: true };
  if (PROVIDER === 'stripe') {
    const stripe = require('stripe')(process.env.STRIPE_API_KEY);
    const session = await stripe.checkout.sessions.retrieve(providerRef);
    return { paid: session.payment_status === 'paid' };
  }
  if (PROVIDER === 'paypal') {
    const token = await paypalToken();
    const captureRes = await fetch(`${paypalBase()}/v2/checkout/orders/${providerRef}/capture`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    const capture = await captureRes.json();
    return { paid: capture.status === 'COMPLETED' };
  }
  throw new Error(`Unknown PAYMENT_PROVIDER "${PROVIDER}".`);
}

// ---- subscriptions ----
// Stripe: Checkout Session in 'subscription' mode against a pre-created Price.
// PayPal: Subscriptions API against a pre-created Plan (PayPal plans are
// normally set up once via dashboard or a setup script, not per-subscriber —
// PAYPAL_PLAN_ID must already exist).
async function startSubscription({ returnBaseUrl, accountId }) {
  if (MOCK_MODE) return { mock: true, providerRef: 'mock_sub_' + accountId };
  const successUrl = `${returnBaseUrl}#/return?status=success&kind=subscription`;
  const cancelUrl = `${returnBaseUrl}#/return?status=cancel&kind=subscription`;

  if (PROVIDER === 'stripe') {
    const stripe = require('stripe')(process.env.STRIPE_API_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_SUBSCRIPTION_PRICE_ID, quantity: 1 }],
      success_url: successUrl, cancel_url: cancelUrl, metadata: { accountId }
    });
    return { redirectUrl: session.url, providerRef: session.id };
  }
  if (PROVIDER === 'paypal') {
    const token = await paypalToken();
    const subRes = await fetch(`${paypalBase()}/v1/billing/subscriptions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ plan_id: process.env.PAYPAL_PLAN_ID, custom_id: accountId, application_context: { return_url: successUrl, cancel_url: cancelUrl } })
    });
    const sub = await subRes.json();
    const approve = (sub.links || []).find((l) => l.rel === 'approve');
    return { redirectUrl: approve?.href, providerRef: sub.id };
  }
  throw new Error(`Unknown PAYMENT_PROVIDER "${PROVIDER}".`);
}

async function getSubscriptionStatus({ providerRef }) {
  if (MOCK_MODE) return { active: true, currentPeriodEnd: new Date(Date.now() + 30 * 864e5) };
  if (PROVIDER === 'stripe') {
    const stripe = require('stripe')(process.env.STRIPE_API_KEY);
    const session = await stripe.checkout.sessions.retrieve(providerRef, { expand: ['subscription'] });
    const sub = session.subscription;
    if (!sub) return { active: false };
    return { active: sub.status === 'active', currentPeriodEnd: new Date(sub.current_period_end * 1000), subscriptionId: sub.id };
  }
  if (PROVIDER === 'paypal') {
    const token = await paypalToken();
    const res = await fetch(`${paypalBase()}/v1/billing/subscriptions/${providerRef}`, { headers: { authorization: `Bearer ${token}` } });
    const sub = await res.json();
    return { active: sub.status === 'ACTIVE', currentPeriodEnd: sub.billing_info?.next_billing_time ? new Date(sub.billing_info.next_billing_time) : null };
  }
  throw new Error(`Unknown PAYMENT_PROVIDER "${PROVIDER}".`);
}

async function cancelSubscription({ providerRef }) {
  if (MOCK_MODE) return { canceled: true };
  if (PROVIDER === 'stripe') {
    const stripe = require('stripe')(process.env.STRIPE_API_KEY);
    await stripe.subscriptions.cancel(providerRef);
    return { canceled: true };
  }
  if (PROVIDER === 'paypal') {
    const token = await paypalToken();
    await fetch(`${paypalBase()}/v1/billing/subscriptions/${providerRef}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'User requested cancellation.' }) });
    return { canceled: true };
  }
  throw new Error(`Unknown PAYMENT_PROVIDER "${PROVIDER}".`);
}

module.exports = { MOCK_MODE, PROVIDER, SUBSCRIPTION_PRICE_CENTS, CATALOG_SUBMISSION_FEE_CENTS, startOneTimePayment, confirmOneTimePayment, startSubscription, getSubscriptionStatus, cancelSubscription };

'use strict';
// One active provider per deployment, chosen via PAYMENT_PROVIDER. Both real
// paths use a hosted-checkout redirect (Stripe Checkout / PayPal Orders +
// approval redirect) rather than embedded card fields, so this app never
// touches raw card data itself. NOTE: the live Stripe/PayPal code below is
// implemented against each provider's documented API shape but has not been
// exercised against a real sandbox in this environment — MOCK_MODE is the
// path that's actually been run end-to-end. Test against real sandbox keys
// before taking any real payment.
const MOCK_MODE = (process.env.MOCK_MODE || 'false').toLowerCase() === 'true';
const PROVIDER = (process.env.PAYMENT_PROVIDER || 'stripe').toLowerCase();
const FEE_CENTS = parseInt(process.env.ATTEMPT_FEE_CENTS, 10) || 1000; // $10 default, applies to every attempt incl. retries

function feeCents() { return FEE_CENTS; }

// Returns { mock: true } (frontend proceeds immediately, no redirect) or
// { redirectUrl, providerRef } for a real provider.
async function startPayment({ attemptId, returnBaseUrl }) {
  if (MOCK_MODE) return { mock: true, providerRef: 'mock_' + attemptId };
  const successUrl = `${returnBaseUrl}#/return?attempt=${attemptId}&status=success`;
  const cancelUrl = `${returnBaseUrl}#/return?attempt=${attemptId}&status=cancel`;

  if (PROVIDER === 'stripe') {
    const stripe = require('stripe')(process.env.STRIPE_API_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price_data: { currency: 'usd', unit_amount: FEE_CENTS, product_data: { name: 'Vivacada AI-proctored exam attempt' } }, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { attemptId }
    });
    return { redirectUrl: session.url, providerRef: session.id };
  }

  if (PROVIDER === 'paypal') {
    const base = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`${base}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    const { access_token } = await tokenRes.json();
    const orderRes = await fetch(`${base}/v2/checkout/orders`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'USD', value: (FEE_CENTS / 100).toFixed(2) }, custom_id: attemptId }],
        application_context: { return_url: successUrl, cancel_url: cancelUrl }
      })
    });
    const order = await orderRes.json();
    const approve = (order.links || []).find((l) => l.rel === 'approve');
    return { redirectUrl: approve?.href, providerRef: order.id };
  }

  throw new Error(`Unknown PAYMENT_PROVIDER "${PROVIDER}".`);
}

// Called when the user's browser returns from the provider (or immediately,
// in mock mode). Verifies the payment server-side — never trusts a bare
// "it succeeded" from the client redirect alone.
async function confirmPayment({ providerRef }) {
  if (MOCK_MODE) return { paid: true };

  if (PROVIDER === 'stripe') {
    const stripe = require('stripe')(process.env.STRIPE_API_KEY);
    const session = await stripe.checkout.sessions.retrieve(providerRef);
    return { paid: session.payment_status === 'paid' };
  }

  if (PROVIDER === 'paypal') {
    const base = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`${base}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    const { access_token } = await tokenRes.json();
    const captureRes = await fetch(`${base}/v2/checkout/orders/${providerRef}/capture`, { method: 'POST', headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' } });
    const capture = await captureRes.json();
    return { paid: capture.status === 'COMPLETED' };
  }

  throw new Error(`Unknown PAYMENT_PROVIDER "${PROVIDER}".`);
}

module.exports = { feeCents, startPayment, confirmPayment, MOCK_MODE, PROVIDER };

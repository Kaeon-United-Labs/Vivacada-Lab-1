'use strict';
// The rule for whether a credential can ever be shown to an employer. Kept in
// one place because it's the one privacy invariant that must never drift
// between codebases that touch this data — originally enforced only inside
// the aggregator's own /api/briefs; now also enforced directly by the
// employer app, which reads this database without going through the
// aggregator's API at all. If this logic needs to change, it changes here,
// once, for every caller.

function age(birthdate) {
  if (!birthdate) return null;
  const b = new Date(birthdate), d = new Date();
  let a = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) a--;
  return a;
}

// Age is computed fresh against the stored birthdate every time this is
// called, not frozen at issuance — a credential earned at 16 becomes
// eligible the moment today's date implies the holder has turned 18, with no
// re-issuing or re-approval needed. A missing/unparseable birthdate is
// treated as unknown, not as adult, so it's excluded rather than assumed safe.
function isEmployerEligible(credential, holder) {
  if (!credential || credential.visibility !== 'public') return false;
  if (!holder || !holder.dataSharing) return false;
  const a = age(credential.birthdate);
  return a !== null && a >= 18;
}

module.exports = { age, isEmployerEligible };

'use strict';
// The rules for what's a valid catalogEntries document. Kept in one place so
// an entry created via the aggregator's own admin panel and one approved
// through the employer app's paid submission flow are held to the identical
// standard — main subjects don't require a description, special subjects do
// (the exam is generated entirely from it), and subject names are unique.

// Pure validation — no DB access. Throws a plain Error with a user-facing
// message; callers turn that into whatever HTTP response their framework
// wants. Returns the cleaned { subject, description, catalogType }.
function validateCatalogInput({ subject, description, catalogType }) {
  const clean = (subject || '').trim();
  if (!clean) throw new Error('Subject name required.');
  const type = catalogType === 'special' ? 'special' : 'main';
  const desc = (description || '').trim();
  if (type === 'special' && !desc) throw new Error('A special-catalog subject needs a description — the exam is generated entirely from it.');
  return { subject: clean, description: desc, catalogType: type };
}

// Needs a live query, so it takes the caller's own db handle rather than
// living inside the pure validator above.
async function assertNoDuplicateSubject(db, subject) {
  const dup = await db.collection('catalogEntries').findOne({ subject });
  if (dup) throw new Error('A subject with this name already exists.');
}

module.exports = { validateCatalogInput, assertNoDuplicateSubject };

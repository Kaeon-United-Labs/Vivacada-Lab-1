'use strict';
const crypto = require('crypto');
const { newId } = require('./db');
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

const STARTER_CATALOG = [
  { subject: 'Algorithms & Data Structures', description: 'Sorting, searching, graphs, complexity analysis, and core data-structure trade-offs.', catalogType: 'main' },
  { subject: 'Classical Mechanics', description: 'Newtonian mechanics: kinematics, dynamics, energy, momentum, and rotational motion.', catalogType: 'main' },
  { subject: 'Contract Law', description: 'Formation, consideration, performance, breach, and remedies under contract law.', catalogType: 'main' },
  // Illustrative special-catalog entry: not browsable, found only by typing its
  // exact name; no chosen level; the exam is generated entirely from this description.
  { subject: 'Home Espresso Brewing', description: 'Practical espresso-machine operation: grind and dose calibration, extraction troubleshooting (channeling, sour or bitter shots), milk steaming and latte art basics, and machine maintenance.', catalogType: 'special' }
];

async function seed(db) {
  const users = db.collection('users');
  const adminEmail = process.env.ADMIN_EMAIL, adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const existing = await users.findOne({ email: adminEmail });
    if (!existing) {
      const salt = crypto.randomBytes(8).toString('hex');
      await users.insertOne({
        _id: newId(), email: adminEmail, fullName: 'Admin', passwordHash: salt + ':' + hash(adminPassword, salt),
        role: 'admin', dataSharing: false, birthdate: null, createdAt: new Date().toISOString()
      });
      console.log('[seed] admin account created: ' + adminEmail);
    }
  } else {
    console.log('[seed] ADMIN_EMAIL/ADMIN_PASSWORD not set — no admin account seeded. Set them to manage institutions and the catalog.');
  }

  const catalog = db.collection('catalogEntries');
  if ((await catalog.countDocuments({})) === 0) {
    for (const entry of STARTER_CATALOG) await catalog.insertOne({ _id: newId(), ...entry, createdAt: new Date().toISOString() });
    console.log('[seed] starter catalog seeded (' + STARTER_CATALOG.length + ' entries)');
  }
}

module.exports = { seed };

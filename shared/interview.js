// Interview engine. Produces a fixed-length exam as a sequence of topic
// threads (1–3 questions each, Socratic within a thread). Openers and
// follow-ups are generated per attempt with randomized parameters so exact
// questions vary significantly between attempts, including retakes.
'use strict';

const QUESTIONS_PER_EXAM = (() => {
  const n = parseInt(process.env.QUESTIONS_PER_EXAM, 10);
  return Number.isInteger(n) && n > 0 ? n : 20;
})();
const MAX_THREAD = 3;
const LEVELS = ['beginner', 'intermediate', 'junior', 'senior', 'expert'];
const levelIdx = (lvl) => Math.max(0, LEVELS.indexOf(lvl));

function rng(seedStr) {
  let h = 2166136261 >>> 0;
  for (const ch of String(seedStr)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const shuffle = (r, arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rint = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const rchoice = (r, ...xs) => xs[Math.floor(r() * xs.length)];

function rigorNote(level) {
  return [
    'Keep it to the essential idea, plainly stated.',
    'Give a complete, working answer.',
    'Be precise and justify each step.',
    'I expect professional-grade rigor and explicit attention to trade-offs and edge cases.',
    'I expect authoritative command, including failure modes and the limits of current knowledge.'
  ][levelIdx(level)];
}

// A couple of bespoke maps so the demo has concrete, recognizable questions;
// everything else uses genericThreads, which is competency- or title-driven
// and works for any subject including special-catalog, description-derived ones.
const MAPS = {
  'Algorithms & Data Structures': [
    { id: 'sorting', label: 'sorting & comparators', mode: 'code', concrete: [
      (r, lvl) => `Write code that sorts an array of \`int\` pointers by the values they point to (not the addresses). Assume ${rint(r,4,12)} elements. ${rigorNote(lvl)}`,
      (r, lvl) => `Implement ${rchoice(r,'quicksort','merge sort','heap sort')} and state its worst-case behavior on n = ${rint(r,1000,1000000)}. ${rigorNote(lvl)}`
    ], abstract: [ (r) => `What is a common misconception about average-case vs worst-case cost for the sort you'd reach for first?` ] },
    { id: 'graphs', label: 'graphs & traversal', mode: 'code', concrete: [
      (r, lvl) => `Given a graph with ${rint(r,5,12)} nodes, write code to detect a cycle. State your representation. ${rigorNote(lvl)}`
    ], abstract: [ (r) => `Where does BFS stop being the right tool and DFS take over? Give a specific example.` ] },
    { id: 'complexity', label: 'complexity analysis', mode: 'essay', concrete: [
      (r, lvl) => `Derive the time complexity of a routine that ${rchoice(r,'doubles the array and copies on each insert','recurses on both halves then merges')}. Show the recurrence. ${rigorNote(lvl)}`
    ], abstract: [ (r) => `Explain amortized analysis to someone who only knows worst-case Big-O.` ] }
  ],
  'Classical Mechanics': [
    { id: 'kinematics', label: 'kinematics & dynamics', mode: 'latex', concrete: [
      (r, lvl) => `A block of mass ${rint(r,2,10)} kg slides down a frictionless incline at ${rint(r,15,45)}°. Find its acceleration and speed after ${rint(r,2,6)} s. ${rigorNote(lvl)}`
    ], abstract: [ (r) => `What is a misconception about Newton's third law, and how do you correct it?` ] },
    { id: 'energy', label: 'energy & momentum', mode: 'latex', concrete: [
      (r, lvl) => `Two carts (${rint(r,1,4)} kg, ${rint(r,1,4)} kg) collide ${rchoice(r,'elastically','perfectly inelastically')}. Given one initial speed, find the final state. ${rigorNote(lvl)}`
    ], abstract: [ (r) => `When is energy conservation the wrong tool for a mechanics problem?` ] }
  ]
};

function genericThreads(topic) {
  return [
    { id: 'foundations', label: `foundations of ${topic}`, mode: 'essay', concrete: [
      (r, lvl) => `Work a concrete, realistic problem in ${topic} of your own choosing, end to end. ${rigorNote(lvl)}`
    ], abstract: [
      (r) => `What problem does ${topic} exist to solve, and what must someone understand before it makes sense?`,
      (r) => `Describe a common misconception about ${topic} and explain why it is wrong.`
    ] },
    { id: 'application', label: `applying ${topic}`, mode: 'essay', concrete: [
      (r, lvl) => `Apply ${topic} to a specific scenario ${rchoice(r,'in industry','in research','in everyday life')}. Be concrete. ${rigorNote(lvl)}`
    ], abstract: [ (r) => `Where does ${topic} break down at the edges? Give a case it handles badly.` ] },
    { id: 'diagnosis', label: `diagnosis in ${topic}`, mode: 'essay', concrete: [
      (r, lvl) => `An approach based on ${topic} fails in practice. Walk through how you'd diagnose the likely causes. ${rigorNote(lvl)}`
    ], abstract: [ (r) => `What is an open or contested question in ${topic} that practitioners should follow?` ] },
    { id: 'connections', label: `${topic} in context`, mode: 'essay', concrete: [
      (r, lvl) => `Show how ${topic} connects to ${rchoice(r,'a neighboring discipline','an everyday practical problem','another topic within the same subject')} through a concrete shared problem. ${rigorNote(lvl)}`
    ], abstract: [ (r) => `Explain a core idea of ${topic} twice: once for a beginner, once for a specialist. What changes?` ] },
    { id: 'methods', label: `methods & tools of ${topic}`, mode: 'essay', concrete: [
      (r, lvl) => `Pick a standard method or tool in ${topic}, demonstrate it on a small case, then name one situation where it misleads you. ${rigorNote(lvl)}`
    ], abstract: [ (r) => `What distinguishes a rigorous approach from a sloppy one in ${topic}?` ] },
    { id: 'edges', label: `frontiers of ${topic}`, mode: 'essay', concrete: [
      (r, lvl) => `Take a hard or non-obvious case in ${topic} and work through it. ${rigorNote(lvl)}`
    ], abstract: [ (r) => `What is a genuinely unsettled question in ${topic}, and why is it hard?` ] }
  ];
}

function threadsFor(testRef, competencies) {
  const title = testRef.title;
  if (MAPS[title]) return MAPS[title];
  if (competencies && competencies.length) {
    return competencies.slice(0, 8).map((c, i) => ({
      id: 'comp' + i, label: c, mode: /code|program|algorithm|software/i.test(c) ? 'code' : /math|physic|integral|equation|proof/i.test(c) ? 'latex' : 'essay',
      concrete: [ (r, lvl) => `Demonstrate ${c} on a concrete, realistic task of your choosing. Show your work. ${rigorNote(lvl)}` ],
      abstract: [ (r) => `What is a common misconception about ${c}, and why is it wrong?` ]
    }));
  }
  return genericThreads(title);
}

function buildSchedule(attemptSeed, testRef, competencies) {
  const r = rng(attemptSeed + '|sched');
  const pool = shuffle(r, threadsFor(testRef, competencies));
  const schedule = [];
  let remaining = QUESTIONS_PER_EXAM, ti = 0;
  while (remaining > 0) {
    const thread = pool[ti % pool.length]; ti++;
    const maxLen = Math.min(MAX_THREAD, remaining);
    const len = remaining <= 2 ? remaining : rint(r, 1, maxLen);
    const openerConcrete = r() < 0.6 && thread.concrete && thread.concrete.length > 0;
    schedule.push({ threadId: thread.id, label: thread.label, mode: thread.mode, length: len, openerConcrete });
    remaining -= len;
  }
  return schedule;
}

function openerFor(attemptSeed, testRef, competencies, sched, threadOrdinal, askedSoFar) {
  const threads = threadsFor(testRef, competencies);
  const thread = threads.find((t) => t.id === sched.threadId) || threads[0];
  const hasC = thread.concrete && thread.concrete.length, hasA = thread.abstract && thread.abstract.length;
  const preferConcrete = sched.openerConcrete ^ (threadOrdinal % 2 === 1);
  const primary = (preferConcrete && hasC) ? thread.concrete : (hasA ? thread.abstract : thread.concrete);
  const secondary = primary === thread.concrete ? (hasA ? thread.abstract : []) : (hasC ? thread.concrete : []);
  const priorLast = new Set((askedSoFar || []).map((q) => String(q).split('\n').pop().trim()));
  const banks = [primary, secondary].filter((b) => b && b.length);
  let out = '';
  for (let attempt = 0; attempt < 12; attempt++) {
    const bank = banks[attempt % banks.length];
    const r = rng(attemptSeed + '|open|' + threadOrdinal + '|' + attempt);
    out = pick(r, bank)(r, testRef.level);
    if (!priorLast.has(out.split('\n').pop().trim())) return out;
  }
  return out;
}

function followUpText(attemptSeed, testRef, sched, threadOrdinal, qInThread, lastAnswer) {
  const r = rng(attemptSeed + '|fu|' + threadOrdinal + '|' + qInThread + '|' + (lastAnswer || '').length);
  const words = (lastAnswer || '').trim().split(/\s+/).filter(Boolean).length;
  const label = sched.label;
  if (words < 6) return pick(r, [
    `Let's stay on ${label}, but take a smaller piece: pick one specific part and explain just that.`,
    `That was brief. Give one concrete example on ${label} and walk through it.`
  ]);
  if (words > 260) return pick(r, [
    `You covered a lot. In one or two sentences: what is the single load-bearing idea, and what breaks if it's wrong?`,
    `Commit: which one claim in what you just said are you least sure of, and why?`
  ]);
  return pick(r, [
    `Building on that: ${rchoice(r,'what assumption in your answer is most fragile','what would change your conclusion','what is the boundary case where this stops working')}? Be specific.`,
    `Push one level deeper on ${label}: ${rchoice(r,'give a counterexample','quantify it','name the trade-off you just glossed over')}.`,
    `If we ${rchoice(r,'doubled the input','removed your key assumption','changed the constraint you relied on')}, what happens to your answer?`
  ]);
}

module.exports = { QUESTIONS_PER_EXAM, MAX_THREAD, LEVELS, levelIdx, rng, buildSchedule, openerFor, followUpText, threadsFor };

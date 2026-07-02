import * as install from './install.mjs';
import * as permissionGate from './permission-gate.mjs';
import * as step0Gate from './step0-gate.mjs';
import * as intentPrecompile from './intent-precompile.mjs';
import * as milestoneVerify from './milestone-verify.mjs';
import * as scopeGitSweep from './scope-git-sweep.mjs';
import * as intentAnchor from './intent-anchor.mjs';
import * as scopeRefresh from './scope-refresh.mjs';
import * as finalReview from './final-review.mjs';
import * as doctrine from './doctrine.mjs';
import * as sweep from './sweep.mjs';
import * as c6 from './c6.mjs';

const GROUPS = [
  ['install', install],
  ['permission-gate', permissionGate],
  ['step0-gate', step0Gate],
  ['intent-precompile', intentPrecompile],
  ['milestone-verify', milestoneVerify],
  ['scope-git-sweep', scopeGitSweep],
  ['intent-anchor', intentAnchor],
  ['scope-refresh', scopeRefresh],
  ['final-review', finalReview],
  ['inject-doctrine', doctrine],
  ['sweep', sweep],
  ['c6', c6],
];

export function allChecks(ctx) {
  const out = [];
  for (const [group, mod] of GROUPS) {
    for (const c of mod.checks(ctx)) {
      out.push({ group, name: c.name, run: c.run, warn: c.warn ?? false });
    }
  }
  return out;
}

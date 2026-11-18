// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreditMarket} from "../../src/CreditMarket.sol";

/// Independent, spec-derived reimplementation of the batch-4 motion escrow
/// (docs/design/motion-escrow-and-mark.md §5) for the invariant suites. Written from
/// the design note, NOT by calling the contract's internal math, so a mutation inside
/// CreditMarket's settlement/split shows up as a divergence. Reads only public state.
library EscrowMath {
    struct Ctx {
        CreditMarket m;
        IERC20 yes;
        IERC20 no;
        uint256 idx; // funding index to project to
    }

    function ceil1e18(uint256 x) internal pure returns (uint256) {
        return x == 0 ? 0 : (x - 1) / 1e18 + 1;
    }

    // Index move snap→idx split at the EDD: the open motion's index, or the confirmed
    // motion's after a Yes; otherwise all ordinary.
    function split(CreditMarket m, uint256 snap, uint256 idx) internal view returns (uint256 pre, uint256 post) {
        if (!m.motionPending() && !m.creditEventConfirmed()) return (idx - snap, 0);
        uint256 edd = m.motionIndex(m.motionId());
        if (snap >= edd) return (0, idx - snap);
        if (idx <= edd) return (idx - snap, 0);
        return (edd - snap, idx - edd);
    }

    function outcome(CreditMarket m, uint256 k) internal view returns (CreditMarket.MotionOutcome) {
        return m.motionOutcome(k);
    }

    // owed(u) per the spec: recorded debt + live pre-EDD accrual + (open motion only)
    // live post-EDD accrual, each bucket rounded up.
    function owed(Ctx memory c, address u) internal view returns (uint256) {
        uint256 bal = c.yes.balanceOf(u);
        (uint256 pre, uint256 post) = split(c.m, c.m.fundingSnapshot(u), c.idx);
        uint256 o = c.m.fundingDebt(u) + ceil1e18(bal * pre);
        if (c.m.motionPending()) o += ceil1e18(bal * post);
        return o;
    }

    struct Rec {
        uint256 e;
        uint256 d;
        uint256 credit;
        uint256 debit;
    }

    // What settleFunding(u) would do now for balances (yesBal, noBal): returns
    // cashOut − (total recorded debt after). A positive value is paid out in cash.
    function projectSettle(Ctx memory c, address u, uint256 yesBal, uint256 noBal) internal view returns (int256) {
        Rec memory x = _fold(c, u);
        (uint256 pre, uint256 post) = split(c.m, c.m.snapNO(u), c.idx);
        x.credit += noBal * pre / 1e18;
        uint256 postCredit = noBal * post / 1e18;
        (pre, post) = split(c.m, c.m.fundingSnapshot(u), c.idx);
        x.debit += ceil1e18(yesBal * pre);
        if (c.m.motionPending()) {
            uint256 inC = x.e + postCredit;
            uint256 inD = x.d + ceil1e18(yesBal * post);
            if (inC >= inD) {
                x.d = 0;
            } else {
                x.d = inD - inC;
                if (x.credit > x.debit) {
                    uint256 pay = x.credit - x.debit < x.d ? x.credit - x.debit : x.d;
                    x.credit -= pay;
                    x.d -= pay;
                }
            }
        } else {
            x.d = 0;
        }
        if (x.credit >= x.debit) return int256(x.credit - x.debit) - int256(x.d);
        return -int256(x.debit - x.credit + x.d);
    }

    // Starting point: ordinary debt, plus a resolved motion's record folded in
    // (No → escrow is credit, its debt is ordinary; Yes → refund is credit, rest void).
    function _fold(Ctx memory c, address u) private view returns (Rec memory x) {
        (uint256 e, uint256 d, uint256 r, uint256 k) = c.m.escrowOf(u);
        CreditMarket.MotionOutcome o = outcome(c.m, k);
        // fundingDebt counts d for Open/No records; ordinary debt excludes an Open record's d.
        x.debit = c.m.fundingDebt(u) - (o == CreditMarket.MotionOutcome.Open ? d : 0);
        if (o == CreditMarket.MotionOutcome.No) {
            x.credit = e;
        } else if (o == CreditMarket.MotionOutcome.Yes) {
            x.credit = r;
        } else {
            (x.e, x.d) = (e, d);
        }
    }

    // Collateral the market must hold in each possible resolution of the open motion:
    //   noWorld  — the DC rules No (or no motion open): pairs at $1, all accrued Downbet
    //              credit (paid or escrowed) net of all accrued Upbet debt.
    //   yesWorld — the DC rules Yes (or already did): every Upbet at $1, pre-EDD credit
    //              net of pre-EDD debt, plus every refund owed to post-EDD payers.
    // `extra` is a non-actor that may hold a refund (the InsuranceFund).
    function solvency(Ctx memory c, address[] memory actors, address extra)
        internal
        view
        returns (int256 noWorld, int256 yesWorld, bool hasYesWorld)
    {
        int256 supply = int256(c.yes.totalSupply());
        noWorld = supply;
        yesWorld = supply;
        hasYesWorld = c.m.motionPending() || c.m.creditEventConfirmed();
        for (uint256 i = 0; i <= actors.length; i++) {
            address u = i < actors.length ? actors[i] : extra;
            (int256 dn, int256 dy) = _contribution(c, u);
            noWorld += dn;
            yesWorld += dy;
        }
    }

    function _contribution(Ctx memory c, address u) private view returns (int256 dn, int256 dy) {
        (int256 preNet, int256 postNet) = _liveNets(c, u);
        (uint256 e, uint256 d, uint256 r, uint256 k) = c.m.escrowOf(u);
        CreditMarket.MotionOutcome o = outcome(c.m, k);
        bool open = o == CreditMarket.MotionOutcome.Open;
        uint256 recorded = c.m.fundingDebt(u);

        // No world: post-EDD accrual and escrow are real; refunds lapse.
        dn = -int256(recorded) + preNet + postNet;
        if (open || o == CreditMarket.MotionOutcome.No) dn += int256(e);

        // Yes world: post-EDD accrual, escrow and post-EDD debt are void; refunds paid.
        dy = -int256(recorded - (open ? d : 0)) + preNet;
        if (open || o == CreditMarket.MotionOutcome.Yes) dy += int256(r);
        if (o == CreditMarket.MotionOutcome.No) dy += int256(e); // an earlier motion's released escrow
    }

    // Live (unsettled) Downbet credit minus Upbet debit, pre- and post-EDD.
    function _liveNets(Ctx memory c, address u) private view returns (int256 preNet, int256 postNet) {
        (uint256 yPre, uint256 yPost) = split(c.m, c.m.fundingSnapshot(u), c.idx);
        uint256 yb = c.yes.balanceOf(u);
        preNet = -int256(ceil1e18(yb * yPre));
        postNet = -int256(ceil1e18(yb * yPost));
        (uint256 nPre, uint256 nPost) = split(c.m, c.m.snapNO(u), c.idx);
        uint256 nb = c.no.balanceOf(u);
        preNet += int256(nb * nPre / 1e18);
        postNet += int256(nb * nPost / 1e18);
    }
}

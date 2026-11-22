"""What quantum entanglement does — and what it cannot do — computed, not asserted.

Run:  python3 tools/entangle/bell_demo.py

Two qubits in the singlet state |Ψ⁻> = (|01> - |10>)/√2.

Part 1 measures the thing entanglement IS: correlations stronger than any
local hidden-variable theory can produce (CHSH = 2√2 > 2).

Part 2 measures the thing entanglement is NOT: a communication channel.
Bob's marginal distribution is exactly 50/50 no matter which axis Alice
measures on, so Alice cannot signal him by choosing her axis. This is the
no-signalling theorem, and it is the reason entanglement cannot "rebuild" or
"accelerate" anything on its own: it is a correlation resource, not a wire and
not a processor.

The same 2√2 is also the reason entanglement *is* useful: it is the resource
behind quantum error correction, and its mathematics — the Schmidt
decomposition and the entanglement spectrum — is exactly the tensor-network
(MPS/MPO) language used in Part 3 of this rebuild.
"""

import itertools
import math

import numpy as np

# Pauli matrices
I2 = np.eye(2, dtype=complex)
X = np.array([[0, 1], [1, 0]], dtype=complex)
Y = np.array([[0, -1j], [1j, 0]], dtype=complex)
Z = np.array([[1, 0], [0, -1]], dtype=complex)


def kron(a, b):
    return np.kron(a, b)


def observable(axis_deg, which):
    """Spin observable cosθ·Z + sinθ·X on qubit `which` (0=Alice, 1=Bob)."""
    th = math.radians(axis_deg)
    o = math.cos(th) * Z + math.sin(th) * X
    return kron(o, I2) if which == 0 else kron(I2, o)


def singlet():
    psi = np.zeros(4, dtype=complex)
    psi[1] = 1 / math.sqrt(2)   # |01>
    psi[2] = -1 / math.sqrt(2)  # |10>
    return psi


def main():
    psi = singlet()
    rho = np.outer(psi, psi.conj())

    print("state: |Ψ⁻> = (|01> - |10>)/√2")
    print(f"  norm            {np.linalg.norm(psi):.12f}")
    print(f"  purity Tr(ρ²)   {np.real(np.trace(rho @ rho)):.12f}   (1.0 = pure)")

    # -- Part 1: the correlations -------------------------------------
    # CHSH: E(a,b) - E(a,b') + E(a',b) + E(a',b') with the singlet's optimal
    # angles. For |Ψ⁻>, E(x,y) = -cos(x-y); the maximum is 2√2 at
    # a=0°, a'=90°, b=45°, b'=135°.
    a, ap, b, bp = 0.0, 90.0, 45.0, 135.0

    def E(x, y):
        return float(np.real(psi.conj() @ observable(x, 0) @ observable(y, 1) @ psi))

    chsh = E(a, b) - E(a, bp) + E(ap, b) + E(ap, bp)
    chsh = abs(chsh)
    print("\nPart 1 — correlation strength (CHSH inequality)")
    for x, y in [(a, b), (a, bp), (ap, b), (ap, bp)]:
        print(f"  E(Alice {x:>5.0f}°, Bob {y:>5.0f}°) = {E(x, y):+.6f}")
    print(f"  CHSH = {chsh:.9f}")
    print(f"  2√2   = {2 * math.sqrt(2):.9f}")
    print(f"  classical bound 2 exceeded: {chsh > 2}   (Tsirelson bound reached: "
          f"{abs(chsh - 2 * math.sqrt(2)) < 1e-9})")

    # perfect anticorrelation along the same axis
    same = [E(t, t) for t in (0, 30, 60, 90, 137)]
    print(f"  same-axis correlation E(θ,θ) for θ ∈ {{0,30,60,90,137}}°: "
          f"{[round(s, 6) for s in same]}")

    # -- Part 2: no signalling ----------------------------------------
    # Alice measures along some axis; Bob holds his qubit. Compute Bob's
    # *conditional* state for each of Alice's outcomes, then his marginal.
    # If the marginal after Alice's measurement does not depend on her axis,
    # she cannot signal him by choosing it.
    print("\nPart 2 — can Alice send a message by choosing her axis?")

    def alice_projectors(axis_deg):
        th = math.radians(axis_deg)
        o = math.cos(th) * Z + math.sin(th) * X
        eigs, vecs = np.linalg.eigh(o)
        return [kron(vecs[:, i:i + 1] @ vecs[:, i:i + 1].conj().T, I2)
                for i in range(2)]  # i=0 -> +1, i=1 -> -1

    def bob_state_after(rho_q, alice_outcome):
        """Bob's reduced state (unnormalised) after Alice's outcome, and its
        probability. rho is 4x4 on (Alice, Bob); trace out Alice."""
        full = alice_projectors_cache[alice_outcome] @ rho_q
        p = float(np.real(np.trace(full)))
        # index order: (a_out, b_out, a_in, b_in)
        arr = full.reshape(2, 2, 2, 2)
        red = np.trace(arr, axis1=0, axis2=2)  # sum over Alice -> 2x2 on Bob
        return red, p

    bob_plus = kron(I2, (I2 + Z) / 2)
    axis_rows = []
    for alice_axis in (0, 30, 45, 90, 137):
        alice_projectors_cache = alice_projectors(alice_axis)
        p_bob_plus = float(np.real(np.trace(rho @ bob_plus)))
        cond = []
        for outcome in (0, 1):  # Alice got +1, -1
            red, p_outcome = bob_state_after(rho, outcome)
            if abs(p_outcome) > 1e-12:
                red = red / p_outcome
            cond.append(float(np.real(np.trace(red @ (I2 + Z) / 2))))
        axis_rows.append((alice_axis, p_bob_plus, cond))
        print(f"  Alice axis {alice_axis:>3}° → Bob P(+1): marginal {p_bob_plus:.9f} | "
              f"given Alice +: {cond[0]:.9f} | given Alice −: {cond[1]:.9f}")
    worst_marginal = max(abs(r[1] - 0.5) for r in axis_rows)
    worst_mix = max(abs(0.5 * (r[2][0] + r[2][1]) - 0.5) for r in axis_rows)
    print(f"\n  max |marginal − 0.5| across Alice's axes: {worst_marginal:.2e}")
    print(f"  max |½(P(+|+)+P(+|−)) − 0.5|:            {worst_mix:.2e}")
    print("  The conditional splits are strong (that is the entanglement), but")
    print("  they are conditioned on Alice's *outcome*, which only she can see;")
    print("  averaged over her outcomes Bob's statistics are exactly 50/50 for")
    print("  every axis she might have chosen. → entanglement carries no signal,")
    print("  so it cannot be a wire, a processor, or a rebuild engine on its own.")

    # -- Part 3: why this becomes tensor networks ---------------------
    # Any pure bipartite state has a Schmidt decomposition; its squared
    # coefficients are the entanglement spectrum, and truncating them is
    # exactly what an MPS does to a weight matrix.
    print("\nPart 3 — the bridge to this rebuild (Schmidt decomposition)")
    # Reshape the 4-dim state as a 2x2 matrix and SVD it.
    M = psi.reshape(2, 2)
    s = np.linalg.svd(M, compute_uv=False)
    print(f"  Schmidt coefficients of |Ψ⁻>: {np.round(s, 9)}")
    print(f"  squared (the entanglement spectrum): {np.round(s**2, 9)}")
    ent = -sum(p * math.log2(p) for p in s**2 if p > 0)
    print(f"  von Neumann entropy = {ent:.6f} bits   (max for 2 qubits = 1)")
    print("  A weight matrix W has the SAME structure: W = U·diag(s)·Vᵀ.")
    print("  `s` is its entanglement spectrum; truncating it at bond dimension")
    print("  χ is an MPS/MPO rebuild. That is what the next step measures.")


if __name__ == "__main__":
    main()

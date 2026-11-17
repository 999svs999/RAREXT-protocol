"""The task suite the agent evolves on, and the rewards it is judged by.

Every reward is COMPUTED, not model-judged: the checker is code, so the reward
signal cannot be gamed by a reward model's opinions. The NVIDIA teacher only
*proposes* training examples; nothing it says enters training until this file's
checker accepts it.

Skills (each new one is a capability the deployed host did not have):

  S0  price-copy    read one row, say its price          (deployed skill)
  S1  cheapest      compare 2-3 rows, name the minimum  (added by evolution)
  S2  priciest      compare 2-3 rows, name the maximum  (added by evolution)

Prompt shapes (the provider sends the last user turn verbatim):

  S0:  rows: -ITEM|$PRICE
       q: {question}
       a:
  S1/2: rows: -ITEM|$P
        -ITEM|$P
        q: which is cheapest? | which is most expensive?
        a:
"""

import random

# --------------------------------------------------------------------------
# shared vocabulary
# --------------------------------------------------------------------------
WORDS = [
    "BAPE", "STA", "BABY", "MILO", "SHARK", "TEE", "HOODIE", "CREW", "SOCKS",
    "CAP", "BOX", "GIFT", "QUILTED", "VEST", "DOWN", "SHORTS", "PANTS", "JACKET",
    "CAMO", "BIG", "APE", "HEAD", "CITY", "TIGER", "COLLEGE", "STORE", "LOW",
    "HIGH", "WHITE", "BLACK", "GREY", "NAVY", "RED", "MEGA", "MINI", "CLASSIC",
]
S0_QUESTIONS = [
    "how much is the {item}?", "what does the {item} cost?", "price of the {item}?",
    "how much for the {item}?", "what is the price of the {item}?",
]
GENERIC_QUESTIONS = ["how much is it?", "how much?", "what's the price?", "price?"]

S0_ANSWER = "The price is ${price} delivered."


def make_item(rng: random.Random) -> str:
    n = rng.choice([1, 2, 2, 3, 3, 4])
    parts = [rng.choice(WORDS) for _ in range(n)]
    if rng.random() < 0.15:
        parts.insert(rng.randrange(len(parts) + 1), rng.choice(["#1", "#2", "II"]))
    label = " ".join(parts)
    return label.lower() if rng.random() < 0.45 else label


def make_price(rng: random.Random) -> str:
    return str(rng.randrange(49, 999))


# --------------------------------------------------------------------------
# S0 — the deployed skill
# --------------------------------------------------------------------------
def s0_example(rng: random.Random):
    item = make_item(rng)
    price = make_price(rng)
    roll = rng.random()
    if roll < 0.25:
        question = rng.choice(GENERIC_QUESTIONS)
    else:
        question = rng.choice(S0_QUESTIONS).format(item=item)
    prompt = f"rows: -{item}|${price}\nq: {question}\na: "
    return prompt, S0_ANSWER.format(price=price)


# --------------------------------------------------------------------------
# S1 / S2 — comparison skills the evolution adds
#
# The answer reuses the deployed template ON PURPOSE. The first evolution
# attempt taught a new surface form ("The cheapest is $X (item).") from 300
# checker-verified NVIDIA teacher seeds: sampling found the new form ~30% of
# the time, but the policy's GREEDY mode never left the old template — a
# 1.3M-byte model memorises 300 demonstrations without generalising the
# template switch, and the serving path reads the mode. Sharing the template
# removes the mode conflict entirely: the skill left to learn is the actual
# comparison (which row's price to copy), and the model's existing behaviour
# bootstraps the reward from rollout #1.
# --------------------------------------------------------------------------
COMP_ANSWER = {"cheapest": S0_ANSWER, "priciest": S0_ANSWER}
COMP_QUESTION = {"cheapest": "which is cheapest?",
                 "priciest": "which is most expensive?"}


def comp_example(rng: random.Random, kind: str | None = None, n_rows: int | None = None):
    kind = kind or rng.choice(["cheapest", "priciest"])
    n = n_rows or rng.choice([2, 2, 2, 3])
    # Every row in one example shares a digit length (3 or 4): comparing
    # fixed-length digit strings is a learnable circuit for a small model,
    # while mixed lengths ("$86" vs "$994") need digit-alignment the current
    # 1.3M-parameter policy never found. The depot's price range lives here.
    L = rng.choice([3, 3, 3, 4])
    lo, hi = 10 ** (L - 1), 10 ** L - 1
    prices = rng.sample(range(lo, hi), n)
    items = []
    while len(items) < n:
        cand = make_item(rng)
        if cand not in items:
            items.append(cand)
    rows = "".join(
        ("rows: " if i == 0 else "") + f"-{it}|${pr}\n" for i, (it, pr) in enumerate(zip(items, prices))
    )
    prompt = f"{rows}q: {COMP_QUESTION[kind]}\na: "
    target = max(zip(prices, items)) if kind == "priciest" else min(zip(prices, items))
    answer = COMP_ANSWER[kind].format(price=str(target[0]), item=target[1])
    return prompt, answer


# --------------------------------------------------------------------------
# rewards — computed, deterministic
# --------------------------------------------------------------------------
def reward(prompt: str, answer: str) -> float:
    """1.0 for the exact string; partial credit so REINFORCE has a gradient
    from the very first rollouts (right template, right price, right item)."""
    if "which is most expensive?" in prompt:
        kind, answers = "priciest", _parse_comp(prompt)
    elif "which is cheapest?" in prompt:
        kind, answers = "cheapest", _parse_comp(prompt)
    else:
        return 1.0 if answer == _canon_s0(prompt, answer) else 0.0

    if not answers:
        return 0.0
    prices = [p for p, _ in answers]
    want_price = max(prices) if kind == "priciest" else min(prices)
    got = answer.strip()
    r = 0.0
    if got.startswith("The price is $"):
        r += 0.2
    if f"${want_price}" in got:
        r += 0.8
    if got.rstrip(".") == COMP_ANSWER[kind].format(price=str(want_price)).rstrip("."):
        r = 1.0
    return r


def _parse_comp(prompt: str):
    rows = []
    for line in prompt.splitlines():
        t = line.strip()
        if t.startswith("rows: -") or (t.startswith("-") and "|" in t):
            body = t.split("-", 1)[1]
            if "|" in body:
                item, price = body.rsplit("|$", 1)
                if price.strip().isdigit():
                    rows.append((int(price.strip()), item.strip()))
    return rows


def _canon_s0(prompt: str, answer: str) -> str:
    import re

    m = re.search(r"\| \$(\d+)", prompt)
    m2 = re.search(r"\|\$(\d+)", prompt)
    price = (m or m2).group(1) if (m or m2) else None
    return S0_ANSWER.format(price=price) if price else answer


def exact_match(prompt: str, answer: str) -> bool:
    return reward(prompt, answer) == 1.0


# --------------------------------------------------------------------------
# held-out evaluation sets (fixed seeds, never trained on)
# --------------------------------------------------------------------------
def eval_sets(seed: int = 4242):
    rng = random.Random(seed)
    s0 = [s0_example(rng) for _ in range(120)]
    s1 = [comp_example(rng, "cheapest") for _ in range(48)]
    s2 = [comp_example(rng, "priciest") for _ in range(48)]
    return {"S0 price-copy": s0, "S1 cheapest": s1, "S2 priciest": s2}


if __name__ == "__main__":
    rng = random.Random(1)
    for fn in (s0_example, comp_example):
        p, a = fn(rng)
        print(repr(p))
        print("  ->", repr(a), "| reward", reward(p, a))
    # the reward must reject a wrong comparison
    p, right = comp_example(random.Random(2), "cheapest")
    wrong_rows = p.splitlines()
    print("wrong answer reward:", reward(p, "The cheapest is $999 (NOT AN ITEM)."))
    print("right answer reward:", reward(p, right))

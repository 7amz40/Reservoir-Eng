"""van Everdingen-Hurst radial aquifer, constant terminal pressure: cumulative W_D(t_D).
Laplace solution inverted with the Stehfest algorithm; checked against Edwardson et al. (1962)."""
import math
import numpy as np
from scipy.special import ive, kve

def _stehfest_v(N=14):
    V = []
    h = N // 2
    for i in range(1, N + 1):
        s = 0.0
        for k in range((i + 1) // 2, min(i, h) + 1):
            s += (k ** h * math.factorial(2 * k)) / (math.factorial(h - k) * math.factorial(k) * math.factorial(k - 1) * math.factorial(i - k) * math.factorial(2 * k - i))
        V.append((-1) ** (h + i) * s)
    return V
V14 = _stehfest_v(14)

def wd_laplace(s, reD=None):
    a = math.sqrt(s)
    if reD is None or math.isinf(reD):
        return kve(1, a) / (s ** 1.5 * kve(0, a))
    R = kve(1, a * reD) / ive(1, a * reD)
    e = math.exp(2 * a * (1 - reD))
    num = kve(1, a) - ive(1, a) * R * e
    den = kve(0, a) + ive(0, a) * R * e
    return num / (s ** 1.5 * den)

def WD(tD, reD=None):
    if tD <= 0:
        return 0.0
    ln2 = math.log(2.0)
    return ln2 / tD * sum(V14[i - 1] * wd_laplace(i * ln2 / tD, reD) for i in range(1, 15))

def edwardson(tD):
    if tD < 0.01:
        return 2 * math.sqrt(tD / math.pi)
    if tD < 200:
        r = math.sqrt(tD)
        return (1.12838 * r + 1.19328 * tD + 0.269872 * tD * r + 0.00855294 * tD * tD) / (1 + 0.616599 * r + 0.0413008 * tD)
    return (-4.29881 + 2.02566 * tD) / math.log(tD)

if __name__ == "__main__":  # quick self-check
    print("infinite aquifer: Stehfest vs Edwardson")
    for t in [0.1, 1, 5.67, 10, 28.35, 56.7, 100, 500]:
        print(f"  tD={t:8.2f}  WD={WD(t):10.4f}  Edwardson={edwardson(t):10.4f}")
    for reD in [2, 3, 5, 10]:
        lim = (reD * reD - 1) / 2
        vals = [WD(t, reD) for t in [1, 5.67, 11.34, 28.35, 56.7, 200]]
        print(f"reD={reD:>2}: limit {lim:6.2f}  WD at tD 1,5.67,11.34,28.35,56.7,200 = " + ", ".join(f"{v:.3f}" for v in vals))

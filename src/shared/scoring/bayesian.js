/**
 * Bayesian Scoring and Statistical Rigor.
 * Implements Beta-Binomial conjugate prior model for mention rate estimation.
 */

// Log-gamma function (Lanczos approximation)
export function gammaln(x) {
  let j = 0;
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5
  ];
  let ser = 1.000000000190015;
  let xx, y, tmp;
  tmp = (y = xx = x) + 5.5;
  tmp -= (xx + 0.5) * Math.log(tmp);
  for (; j < 6; j++) {
    ser += cof[j] / ++y;
  }
  return Math.log(2.5066282746310005 * ser / xx) - tmp;
}

// Continued fraction for incomplete beta function (modified Lentz's method)
export function betacf(x, a, b) {
  const fpmin = 1e-30;
  let m = 1;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  let m2, aa, del, h;

  if (Math.abs(d) < fpmin) {
    d = fpmin;
  }
  d = 1 / d;
  h = d;

  for (; m <= 100; m++) {
    m2 = 2 * m;
    aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    // One step (the even one) of the recurrence
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) {
      d = fpmin;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) {
      c = fpmin;
    }
    d = 1 / d;
    h *= d * c;
    
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    // Next step of the recurrence (the odd one)
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) {
      d = fpmin;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) {
      c = fpmin;
    }
    d = 1 / d;
    del = d * c;
    h *= del;
    if (Math.abs(del - 1.0) < 3e-7) {
      break;
    }
  }

  return h;
}

// Regularized incomplete beta function I_x(a, b)
export function ibeta(x, a, b) {
  if (x < 0 || x > 1) {
    return NaN;
  }
  
  if (x === 0) {
    return 0;
  }
  if (x === 1) {
    return 1;
  }

  // Factor in front of the continued fraction
  const bt = Math.exp(
    gammaln(a + b) - gammaln(a) - gammaln(b) +
    a * Math.log(x) + b * Math.log(1 - x)
  );

  if (x < (a + 1) / (a + b + 2)) {
    // Use continued fraction directly
    return bt * betacf(x, a, b) / a;
  }
  
  // Use continued fraction after symmetry transformation
  return 1 - bt * betacf(1 - x, b, a) / b;
}

// Inverse of regularized incomplete beta function (Newton-Raphson method)
export function ibetainv(p, a, b) {
  const EPS = 1e-8;
  const a1 = a - 1;
  const b1 = b - 1;
  let j = 0;
  let lna, lnb, pp, t, u, err, x, al, h, w, afac;

  if (p <= 0) {
    return 0;
  }
  if (p >= 1) {
    return 1;
  }

  if (a >= 1 && b >= 1) {
    pp = (p < 0.5) ? p : 1 - p;
    t = Math.sqrt(-2 * Math.log(pp));
    x = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t;
    if (p < 0.5) {
      x = -x;
    }
    al = (x * x - 3) / 6;
    h = 2 / (1 / (2 * a - 1) + 1 / (2 * b - 1));
    w = (x * Math.sqrt(al + h) / h) - (1 / (2 * b - 1) - 1 / (2 * a - 1)) *
        (al + 5 / 6 - 2 / (3 * h));
    x = a / (a + b * Math.exp(2 * w));
  } else {
    lna = Math.log(a / (a + b));
    lnb = Math.log(b / (a + b));
    t = Math.exp(a * lna) / a;
    u = Math.exp(b * lnb) / b;
    w = t + u;
    if (p < t / w) {
      x = Math.pow(a * w * p, 1 / a);
    } else {
      x = 1 - Math.pow(b * w * (1 - p), 1 / b);
    }
  }

  afac = -gammaln(a) - gammaln(b) + gammaln(a + b);
  for (; j < 10; j++) {
    if (x === 0 || x === 1) {
      return x;
    }
    err = ibeta(x, a, b) - p;
    t = Math.exp(a1 * Math.log(x) + b1 * Math.log(1 - x) + afac);
    u = err / t;
    x -= (t = u / (1 - 0.5 * Math.min(1, u * (a1 / x - b1 / (1 - x)))));
    if (x <= 0) {
      x = 0.5 * (x + t);
    }
    if (x >= 1) {
      x = 0.5 * (x + t + 1);
    }
    if (Math.abs(t) < EPS * x && j > 0) {
      break;
    }
  }
  return x;
}

/**
 * Computes the Beta-Binomial posterior mean and credible interval.
 * 
 * @param {number} prior - The prior probability (mention rate) (0.0 to 1.0)
 * @param {number} observedMentions - Number of observed mentions
 * @param {number} totalPrompts - Total number of prompts checked
 * @param {number} confidenceLevel - The credible interval confidence level (default: 0.90)
 * @param {number} priorStrength - Prior strength (N0) (default: 10)
 * @returns {Object} Object containing posteriorMean, credibleIntervalLow, and credibleIntervalHigh (all scale 0.0 to 1.0)
 */
export function computePosterior(prior, observedMentions, totalPrompts, confidenceLevel = 0.90, priorStrength = 10) {
  // Ensure inputs are bounded/valid
  const p = Math.max(0.001, Math.min(0.999, prior));
  const k = Math.max(0, observedMentions);
  const n = Math.max(0, totalPrompts);

  // Beta prior parameters
  const alpha0 = p * priorStrength;
  const beta0 = (1 - p) * priorStrength;

  // Beta posterior parameters
  const alphaPost = alpha0 + k;
  const betaPost = beta0 + n - k;

  // Posterior Mean
  const posteriorMean = alphaPost / (alphaPost + betaPost);

  // Credible interval percentiles (e.g. for 90% CI, we want 5th and 95th percentiles)
  const tailProb = (1 - confidenceLevel) / 2;
  const credibleIntervalLow = ibetainv(tailProb, alphaPost, betaPost);
  const credibleIntervalHigh = ibetainv(1 - tailProb, alphaPost, betaPost);

  return {
    posteriorMean,
    credibleIntervalLow,
    credibleIntervalHigh
  };
}

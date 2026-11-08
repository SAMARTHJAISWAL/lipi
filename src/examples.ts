/** The programs in the examples menu. Tests run every one and check its output. */
export interface Example {
  id: string;
  title: string;
  source: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'hello',
    title: 'Hello, numbers',
    source: `// lipi has ints, floats and bools. print shows any of them.
fn main() {
  let answer = 6 * 7;
  print(answer);
  print(answer > 40);
  print(22.0 / 7.0);
}
`,
  },
  {
    id: 'fizzbuzz',
    title: 'FizzBuzz',
    source: `// There are no strings, so 0 stands for Fizz, -1 for Buzz and -2 for FizzBuzz.
fn main() {
  for i in 1..21 {
    if i % 15 == 0 {
      print(-2);
    } else if i % 3 == 0 {
      print(0);
    } else if i % 5 == 0 {
      print(-1);
    } else {
      print(i);
    }
  }
}
`,
  },
  {
    id: 'fib',
    title: 'Fibonacci, two ways',
    source: `// Recursion compiles to WebAssembly calls; the loop version runs in a few instructions.
fn fib(n: int) -> int {
  if n < 2 {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}

fn fib_loop(n: int) -> int {
  let a = 0;
  let b = 1;
  for i in 0..n {
    let next = a + b;
    a = b;
    b = next;
  }
  return a;
}

fn main() {
  print(fib(25));
  print(fib_loop(25));
  print(fib_loop(46)); // the largest that fits in an int
}
`,
  },
  {
    id: 'primes',
    title: 'Primes',
    source: `// Trial division, stopping at the square root.
fn is_prime(n: int) -> bool {
  if n < 2 {
    return false;
  }
  let d = 2;
  while d * d <= n {
    if n % d == 0 {
      return false;
    }
    d += 1;
  }
  return true;
}

fn main() {
  let found = 0;
  let n = 2;
  while found < 15 {
    if is_prime(n) {
      print(n);
      found += 1;
    }
    n += 1;
  }
}
`,
  },
  {
    id: 'collatz',
    title: 'Collatz',
    source: `// Which start below 10,000 takes the most steps to reach 1?
fn steps(start: int) -> int {
  let n = start;
  let count = 0;
  while n != 1 {
    if n % 2 == 0 {
      n = n / 2;
    } else {
      n = 3 * n + 1;
    }
    count += 1;
  }
  return count;
}

fn main() {
  let best = 1;
  let most = 0;
  for start in 1..10000 {
    let s = steps(start);
    if s > most {
      most = s;
      best = start;
    }
  }
  print(best);
  print(most);
}
`,
  },
  {
    id: 'mandelbrot',
    title: 'Mandelbrot',
    source: `// Every pixel of the 256 × 256 canvas: iterate z = z² + c and colour by escape time.
fn colour(i: int, limit: int) -> int {
  if i == limit {
    return 0x0b0a18;
  }
  let t = float(i) / float(limit);
  // Fire: black, then red, yellow and white as points take longer to escape.
  let r = int(255.0 * min(1.0, 8.0 * t));
  let g = int(255.0 * min(1.0, max(0.0, 8.0 * t - 1.0)));
  let b = int(255.0 * min(1.0, max(0.0, 8.0 * t - 2.0)));
  return (r << 16) | (g << 8) | b;
}

fn main() {
  let limit = 120;
  for py in 0..256 {
    for px in 0..256 {
      let cx = -2.2 + float(px) * 3.0 / 256.0;
      let cy = -1.5 + float(py) * 3.0 / 256.0;
      let x = 0.0;
      let y = 0.0;
      let i = 0;
      while i < limit && x * x + y * y <= 4.0 {
        let xt = x * x - y * y + cx;
        y = 2.0 * x * y + cy;
        x = xt;
        i += 1;
      }
      plot(px, py, colour(i, limit));
    }
  }
}
`,
  },
  {
    id: 'circles',
    title: 'Interference rings',
    source: `// Two sets of ripples; where they meet, the pattern beats.
fn main() {
  for y in 0..256 {
    for x in 0..256 {
      let dx1 = float(x - 80);
      let dy1 = float(y - 128);
      let dx2 = float(x - 176);
      let dy2 = float(y - 128);
      let a = int(sqrt(dx1 * dx1 + dy1 * dy1));
      let b = int(sqrt(dx2 * dx2 + dy2 * dy2));
      let v = ((a ^ b) & 15) * 16;
      plot(x, y, (v << 16) | ((255 - v) << 8) | 200);
    }
  }
}
`,
  },
  {
    id: 'errors',
    title: 'A type error',
    source: `// lipi is strict about types: an int and a float don't mix without a conversion.
fn area(r: float) -> float {
  return 3.14159 * r * r;
}

fn main() {
  let r = 2;
  print(area(r));
}
`,
  },
];

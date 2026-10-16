// Dezenter Glut-Hintergrund für Login und Lobby (Canvas, sehr billig).
let canvas: HTMLCanvasElement | null = null; let raf = 0;
export function startEmbers() {
  if (canvas) return;
  canvas = document.createElement('canvas'); canvas.id = 'embers';
  document.body.prepend(canvas);
  const c = canvas.getContext('2d')!;
  const N = 60; const p = Array.from({ length: N }, () => ({ x: Math.random(), y: Math.random(), s: 1 + Math.random() * 2, v: 0.02 + Math.random() * 0.05, w: Math.random() * 6.28 }));
  let last = performance.now();
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = performance.now(); const dt = (now - last) / 1000; last = now;
    const W = canvas!.width = innerWidth, H = canvas!.height = innerHeight;
    c.clearRect(0, 0, W, H);
    for (const e of p) {
      e.y -= e.v * dt; e.x += Math.sin(now / 1000 + e.w) * 0.0002; if (e.y < -0.05) { e.y = 1.05; e.x = Math.random(); }
      c.fillStyle = `rgba(255,${150 + e.s * 20},60,${0.25 + 0.2 * Math.sin(now / 400 + e.w)})`;
      c.beginPath(); c.arc(e.x * W, e.y * H, e.s, 0, 7); c.fill();
    }
  };
  raf = requestAnimationFrame(frame);
}
export function stopEmbers() { if (canvas) { cancelAnimationFrame(raf); canvas.remove(); canvas = null; } }

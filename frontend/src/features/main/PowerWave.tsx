import { useLayoutEffect, useRef } from "react";
const POWER_WAVE_FRAME_MS = 1000 / 30;
const POWER_WAVE_START_MS = 1200;
const POWER_WAVE_STOP_MS = 2000;
const POWER_WAVE_MAX_DELTA_MS = 100;
const POWER_WAVE_COLUMNS = 43;
const POWER_WAVE_ROWS = 20;
const POWER_WAVE_MAX_PIXEL_RATIO = 2;
function createPowerWave() {
  let surface: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let width = 0,
    height = 0,
    color = "";
  let pixelRatio = 1;
  let frame: number | null = null,
    lastFrame: number | null = null;
  let travel = 10,
    phase = 0.72,
    speed = 0,
    target = 0,
    fromSpeed = 0;
  let changedAt = performance.now();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  let swellFrom = 0.18,
    swellTo = 0.96,
    swellStart = 0,
    swellEnd = 16,
    swellStage = 0;
  const particles: { u: number; depth: number; x: number; edge: number; radius: number }[] = [];

  for (let row = 0; row < POWER_WAVE_ROWS; row++) {
    const depth = row / (POWER_WAVE_ROWS - 1);
    for (let col = 0; col < POWER_WAVE_COLUMNS; col++) {
      const u = col / (POWER_WAVE_COLUMNS - 1);
      particles.push({
        u: u,
        depth: depth,
        x: 0.5 + (u - 0.5) * 0.9 * (0.72 + 0.28 * depth),
        edge: 0.3 + 0.7 * Math.pow(Math.sin(u * Math.PI), 0.45),
        radius: 0.5 + depth * 0.48,
      });
    }
  }

  function between(low: number, high: number) {
    return low + Math.random() * (high - low);
  }

  function swell() {
    // Long, irregular rises and falls, with quiet periods and no timeline reset.
    while (travel > swellEnd) {
      swellFrom = swellTo;
      swellStart = swellEnd;
      swellStage = (swellStage + 1) % 4;
      if (swellStage === 0) {
        swellTo = between(0.88, 0.98);
        swellEnd += between(13, 20);
      } else if (swellStage === 1) {
        swellEnd += between(3, 6);
      } else if (swellStage === 2) {
        swellTo = between(0.16, 0.24);
        swellEnd += between(15, 22);
      } else {
        swellEnd += between(3, 7);
      }
    }
    const progress = Math.max(0, Math.min(1, (travel - swellStart) / (swellEnd - swellStart)));
    const eased = progress * progress * progress * (progress * (progress * 6 - 15) + 10);
    return swellFrom + (swellTo - swellFrom) * eased;
  }

  function draw() {
    if (!context || !width || !height) return;
    const energy = swell() * speed;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = color;
    for (const particle of particles) {
      const depth = particle.depth;
      const angle = particle.u * Math.PI * 2 * 1.02 - phase * 0.92 + depth * 1.12;
      const bend = 0.09 * Math.sin(particle.u * Math.PI + travel * 0.063);
      const y =
        height * (0.5 + (depth - 0.5) * 0.25) +
        height * 0.32 * energy * Math.sin(angle + bend) * (0.88 + 0.12 * depth);
      const light = 0.78 + 0.22 * Math.cos(angle - 0.6);
      context.globalAlpha = (0.18 + depth * 0.68) * particle.edge * light;
      context.beginPath();
      context.arc(width * particle.x, y, particle.radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  function setMotion(motion: string) {
    if (surface && surface.dataset.motion !== motion) surface.dataset.motion = motion;
  }

  function cancelFrame() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    lastFrame = null;
  }

  function tick(now: number) {
    frame = null;
    if (!context || !surface || !surface.isConnected || document.hidden || reducedMotion.matches) return;
    if (lastFrame !== null && now - lastFrame < POWER_WAVE_FRAME_MS) {
      frame = requestAnimationFrame(tick);
      return;
    }
    const delta = lastFrame === null ? 0 : Math.min(now - lastFrame, POWER_WAVE_MAX_DELTA_MS);
    lastFrame = now;
    const progress = Math.min(1, (now - changedAt) / (target ? POWER_WAVE_START_MS : POWER_WAVE_STOP_MS));
    const eased = progress * progress * (3 - 2 * progress);
    const previousSpeed = speed;
    speed = fromSpeed + (target - fromSpeed) * eased;
    const elapsed = ((previousSpeed + speed) * 0.5 * delta) / 1000;
    travel += elapsed;
    phase += elapsed * (0.36 + 0.026 * Math.sin(travel * 0.117) + 0.018 * Math.sin(travel * 0.071));
    setMotion(speed === target ? (target ? "moving" : "still") : target ? "accelerating" : "decelerating");
    draw();
    if (speed !== target || target) frame = requestAnimationFrame(tick);
    else lastFrame = null;
  }

  function wake() {
    if (reducedMotion.matches) {
      cancelFrame();
      speed = target;
      fromSpeed = target;
      setMotion("still");
      draw();
    } else if (context && !document.hidden && frame === null && (speed !== target || target)) {
      frame = requestAnimationFrame(tick);
    }
  }

  function resize() {
    if (!surface) return;
    const bounds = surface.getBoundingClientRect();
    width = bounds.width;
    height = bounds.height;
    pixelRatio = Math.min(window.devicePixelRatio || 1, POWER_WAVE_MAX_PIXEL_RATIO);
    const bufferWidth = Math.round(width * pixelRatio);
    const bufferHeight = Math.round(height * pixelRatio);
    if (surface.width !== bufferWidth) surface.width = bufferWidth;
    if (surface.height !== bufferHeight) surface.height = bufferHeight;
    refreshColor();
  }

  function refreshColor() {
    if (!surface) return;
    color = window.getComputedStyle(surface).color;
    draw();
  }

  function visibilityChanged() {
    if (document.hidden) cancelFrame();
    else wake();
  }

  const observer = new ResizeObserver(resize);
  reducedMotion.addEventListener("change", wake);
  colorScheme.addEventListener("change", refreshColor);
  document.addEventListener("visibilitychange", visibilityChanged);
  const themeObserver = new MutationObserver(refreshColor);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return {
    mount(node: HTMLCanvasElement, active: boolean) {
      observer.disconnect();
      if (!surface) {
        speed = Number(active);
        fromSpeed = speed;
        target = speed;
      }
      surface = node;
      context = surface.getContext("2d");
      if (target !== Number(active)) {
        fromSpeed = speed;
        target = Number(active);
        changedAt = performance.now();
      }
      setMotion(speed === target ? (target ? "moving" : "still") : target ? "accelerating" : "decelerating");
      resize();
      observer.observe(surface.parentElement!);
      wake();
    },
    destroy() {
      cancelFrame();
      themeObserver.disconnect();
      observer.disconnect();
      reducedMotion.removeEventListener("change", wake);
      colorScheme.removeEventListener("change", refreshColor);
      document.removeEventListener("visibilitychange", visibilityChanged);
      surface = null;
      context = null;
    },
  };
}

export function PowerWave({ active }: { active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wave = useRef<ReturnType<typeof createPowerWave> | null>(null);
  useLayoutEffect(() => {
    wave.current = createPowerWave();
    return () => wave.current?.destroy();
  }, []);
  useLayoutEffect(() => {
    if (canvas.current) wave.current?.mount(canvas.current, active);
  }, [active]);
  return (
    <div className="power-wave-slot" aria-hidden="true">
      <canvas ref={canvas} className="power-wave" data-marker="power-wave" />
    </div>
  );
}

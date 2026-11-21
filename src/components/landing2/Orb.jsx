"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { QUESTIONS } from "./sample";

/*
 * A sphere of answers. The dust is a Fibonacci lattice, laid out by formula so
 * it is identical on every load; the brighter nodes are the sample set's
 * questions, lit by where each answer landed. Nothing here is drawn from a
 * random source.
 */
const DUST = 2600;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const PHI = (Math.sqrt(5) - 1) / 2;
const KIND = { you: 1, r1: 2, r2: 3, none: 4 };

function lattice(count, radius) {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = GOLDEN * i;
    out[i * 3] = Math.cos(t) * r * radius;
    out[i * 3 + 1] = y * radius;
    out[i * 3 + 2] = Math.sin(t) * r * radius;
  }
  return out;
}

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uPixel;
  attribute float aSeed;
  attribute float aKind;
  varying float vKind;
  varying float vSeed;
  varying float vDepth;
  void main() {
    vec3 p = position;
    float wave = sin(p.y * 3.1 + uTime * 0.8 + aSeed * 6.2831) * 0.035
               + sin(p.x * 2.3 - uTime * 0.6) * 0.025;
    p += normalize(p) * wave;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float base = aKind > 0.5 ? (aKind < 1.5 ? 22.0 : 14.0) : 4.2;
    float twinkle = 0.75 + 0.25 * sin(uTime * 1.7 + aSeed * 40.0);
    gl_PointSize = base * twinkle * uPixel * (4.0 / -mv.z);
    vKind = aKind;
    vSeed = aSeed;
    vDepth = smoothstep(-7.0, -3.0, mv.z);
  }
`;

const fragment = /* glsl */ `
  varying float vKind;
  varying float vSeed;
  varying float vDepth;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    float tone = 0.5;
    float alpha = 0.55;
    if (vKind > 0.5 && vKind < 1.5) { tone = 1.0; alpha = 1.0; core = pow(core, 1.4) + smoothstep(0.12, 0.0, d); }
    else if (vKind > 1.5 && vKind < 2.5) { tone = 0.62; alpha = 0.85; }
    else if (vKind > 2.5 && vKind < 3.5) { tone = 0.44; alpha = 0.8; }
    else if (vKind > 3.5) { tone = 0.3; alpha = 0.7; core *= smoothstep(0.32, 0.4, d) + 0.25; }
    gl_FragColor = vec4(vec3(tone), core * alpha * (0.25 + 0.75 * vDepth));
  }
`;

function Points({ pointer }) {
  const group = useRef();
  const material = useRef();

  const geometry = useMemo(() => {
    const dust = lattice(DUST, 1.6);
    const nodes = lattice(QUESTIONS.length, 1.72);
    const total = DUST + QUESTIONS.length;
    const position = new Float32Array(total * 3);
    position.set(dust, 0);
    position.set(nodes, DUST * 3);
    const seed = new Float32Array(total);
    const kind = new Float32Array(total);
    for (let i = 0; i < total; i += 1) seed[i] = (i * PHI) % 1;
    QUESTIONS.forEach((q, i) => { kind[DUST + i] = KIND[q.won]; });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(position, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    g.setAttribute("aKind", new THREE.BufferAttribute(kind, 1));
    return g;
  }, []);

  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uPixel: { value: typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio, 2) },
  }), []);

  useFrame((state, delta) => {
    if (!group.current || !material.current) return;
    material.current.uniforms.uTime.value += delta;
    const g = group.current;
    g.rotation.y += delta * 0.08;
    g.rotation.x += (pointer.current.y * 0.35 - g.rotation.x) * 0.04;
    g.rotation.z += (pointer.current.x * -0.2 - g.rotation.z) * 0.04;
  });

  return (
    <group ref={group}>
      <points geometry={geometry}>
        <shaderMaterial
          ref={material}
          vertexShader={vertex}
          fragmentShader={fragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      <Ring radius={1.98} tilt={[1.2, 0, 0.3]} />
      <Ring radius={2.12} tilt={[1.45, 0.2, -0.4]} opacity={0.08} />
    </group>
  );
}

function Ring({ radius, tilt, opacity = 0.14 }) {
  const geometry = useMemo(() => {
    const pts = [];
    for (let i = 0; i <= 180; i += 1) {
      const a = (i / 180) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [radius]);
  return (
    <lineLoop geometry={geometry} rotation={tilt}>
      <lineBasicMaterial color="#ffffff" transparent opacity={opacity} />
    </lineLoop>
  );
}

export default function Orb() {
  const host = useRef(null);
  const pointer = useRef({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "120px" });
    io.observe(el);
    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      pointer.current.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.current.y = ((e.clientY - r.top) / r.height) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => { io.disconnect(); window.removeEventListener("pointermove", onMove); };
  }, []);

  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <div ref={host} className="lp2-orb" aria-hidden="true">
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, 0, 5.6], fov: 45 }}
        frameloop={visible && !reduced ? "always" : "demand"}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      >
        <Points pointer={pointer} />
      </Canvas>
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";
import styles from "./loop-scene.module.css";

/**
 * The landing page's 3D centrepiece: the Looped In mark at the centre of a ring of AI
 * clients, with traffic pulsing along each connection.
 *
 * The mark is not a decorative stand-in — it is the brand mark's own geometry revolved
 * into three dimensions. The lockup's "OO" is two circles of radius 47 whose centres sit
 * 176 apart, bridged by a concave fillet of radius 75 tangent to both. Sweeping that exact
 * silhouette around its long axis gives two spheres joined by a hyperboloid neck, which is
 * what {@link markProfile} builds. Change a number there and it stops being the logo.
 *
 * Three things are deliberate:
 *
 * - **`three` is imported dynamically.** It is ~600 KB and nothing above the fold needs it,
 *   so it loads after hydration rather than blocking first paint.
 * - **Labels are projected HTML, not sprites.** Real DOM text is selectable, readable by a
 *   screen reader, crisp at any DPI, and inherits the theme's colours from CSS — a canvas
 *   sprite gets none of that and would have to be redrawn on a colour-scheme change.
 * - **The palette follows the colour scheme.** Sky is all but invisible on the cream ground
 *   (~1.03:1) and indigo goes muddy on the warm near-black, so the client nodes swap between
 *   plum and sky the same way `--li-rule` does in globals.css.
 */

const CLIENTS = [
  { id: "claude", label: "Claude" },
  { id: "openai", label: "OpenAI" },
  { id: "mcp", label: "Any MCP client" },
] as const;

/** Brand geometry, in the lockup's own units. See public/looped-in-mark.svg. */
const MARK = {
  length: 271,
  nodeRadius: 47,
  leftCentre: 47,
  rightCentre: 223,
  filletCentre: 135,
  filletRadius: 75,
  /** Distance from the mark's axis down to the fillet's centre: 47 − (−37.5). */
  filletOffset: 84.5,
  tangentLeft: 80.9,
  tangentRight: 189.1,
} as const;

/** World units per lockup unit — the mark ends up 2.71 across. */
const SCALE = 0.01;

type Palette = {
  mark: number;
  client: number;
  link: number;
  pulse: number;
};

const LIGHT: Palette = {
  mark: 0x4e67b1, // --li-indigo, 3.8:1 on the cream ground
  client: 0x351f40, // the lockup's own plum — sky would vanish on cream
  link: 0x4e67b1,
  pulse: 0x351f40,
};

const DARK: Palette = {
  mark: 0x4e67b1,
  client: 0xbbdfe8, // --li-sky, the legible accent on the warm near-black
  link: 0xbbdfe8,
  pulse: 0xbbdfe8,
};

/**
 * The mark's silhouette as a lathe profile: radius from the long axis at each point along it.
 * Piecewise — sphere, concave fillet, sphere — meeting at the tangent points, which is why the
 * joins are smooth rather than creased.
 */
function markProfile(THREE: typeof import("three"), segments: number) {
  const points: InstanceType<typeof THREE.Vector2>[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const x = (i / segments) * MARK.length;

    let radius: number;
    if (x <= MARK.tangentLeft) {
      radius = Math.sqrt(
        Math.max(0, MARK.nodeRadius ** 2 - (x - MARK.leftCentre) ** 2),
      );
    } else if (x >= MARK.tangentRight) {
      radius = Math.sqrt(
        Math.max(0, MARK.nodeRadius ** 2 - (x - MARK.rightCentre) ** 2),
      );
    } else {
      radius =
        MARK.filletOffset -
        Math.sqrt(
          Math.max(0, MARK.filletRadius ** 2 - (x - MARK.filletCentre) ** 2),
        );
    }

    // Lathe revolves around Y, so the profile is (radius, distance-along-axis); the mesh
    // is rotated a quarter turn afterwards to lay the mark horizontal.
    points.push(
      new THREE.Vector2(radius * SCALE, (x - MARK.length / 2) * SCALE),
    );
  }
  return points;
}

export function LoopScene() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelListRef = useRef<HTMLUListElement | null>(null);
  const labelRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    let disposed = false;
    let teardown: (() => void) | undefined;

    void (async () => {
      const THREE = await import("three");
      if (disposed || !mount.isConnected) return;

      const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
      let palette = schemeQuery.matches ? DARK : LIGHT;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          alpha: true,
          antialias: true,
          powerPreference: "high-performance",
        });
      } catch {
        // No WebGL (old browser, blocked GPU, headless). The page still reads without the
        // scene — the lockup, the copy and the CTAs are all real DOM — so this stays silent.
        return;
      }

      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      mount.appendChild(renderer.domElement);

      // --- the mark ------------------------------------------------------------------
      const markMaterial = new THREE.MeshStandardMaterial({
        color: palette.mark,
        metalness: 0.08,
        roughness: 0.42,
      });
      const mark = new THREE.Mesh(
        new THREE.LatheGeometry(markProfile(THREE, 96), 72),
        markMaterial,
      );
      mark.rotation.z = Math.PI / 2; // lay the revolved form along X
      const markGroup = new THREE.Group();
      markGroup.add(mark);
      scene.add(markGroup);

      // --- the clients, their links, and the traffic on them --------------------------
      // Sized so the ring plus its labels stay inside the frame at the narrowest column the
      // landing page gives this scene — the nodes clipped at the edges when it was wider.
      const ORBIT_RADIUS = 2.75;
      /** World-space lift from a node's centre to its label, clear of the 0.3 sphere. */
      const LABEL_LIFT = 0.62;
      const clientMaterial = new THREE.MeshStandardMaterial({
        color: palette.client,
        metalness: 0.05,
        roughness: 0.5,
      });
      const linkMaterial = new THREE.MeshBasicMaterial({
        color: palette.link,
        transparent: true,
        opacity: 0.42,
      });
      const pulseMaterial = new THREE.MeshBasicMaterial({ color: palette.pulse });

      const nodeGeometry = new THREE.SphereGeometry(0.3, 32, 20);
      // A unit-height cylinder standing on Y; each frame it is scaled to the link's length
      // and rotated onto it, which is how you get a line with real thickness (WebGL ignores
      // LineBasicMaterial.linewidth above 1).
      const linkGeometry = new THREE.CylinderGeometry(0.018, 0.018, 1, 8);
      const pulseGeometry = new THREE.SphereGeometry(0.062, 12, 10);

      const orbit = new THREE.Group();
      orbit.rotation.x = -0.34;
      scene.add(orbit);

      const spokes = CLIENTS.map((client, index) => {
        const angle = (index / CLIENTS.length) * Math.PI * 2;
        const node = new THREE.Mesh(nodeGeometry, clientMaterial);
        node.position.set(
          Math.cos(angle) * ORBIT_RADIUS,
          0,
          Math.sin(angle) * ORBIT_RADIUS,
        );
        orbit.add(node);

        const link = new THREE.Mesh(linkGeometry, linkMaterial);
        orbit.add(link);

        const pulse = new THREE.Mesh(pulseGeometry, pulseMaterial);
        orbit.add(pulse);

        return { client, node, link, pulse, phase: index / CLIENTS.length };
      });

      const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
      keyLight.position.set(2.6, 3.4, 4.2);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0xffffff, 0.7);
      fillLight.position.set(-3.2, -1.4, 2.0);
      scene.add(fillLight);
      scene.add(new THREE.AmbientLight(0xffffff, 1.25));

      // --- responsive framing ---------------------------------------------------------
      // Label widths are fixed pixels while the scene scales with the viewport, so on a
      // narrow screen a label on an outer node overhangs the stage. Cached here rather than
      // read per frame: `offsetWidth` forces layout, and the width only changes when the
      // font or the box does.
      const labelHalfWidths: number[] = [];
      const measureLabels = () => {
        labelRefs.current.forEach((label, index) => {
          labelHalfWidths[index] = label ? label.offsetWidth / 2 : 0;
        });
      };

      const resize = () => {
        const rect = mount.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        camera.aspect = width / height;
        // Pull back when the viewport is narrower than it is tall, so the orbit ring stays
        // inside the frame instead of being cropped at the sides on a phone.
        camera.position.set(0, 0.75, 8.6 / Math.min(1, camera.aspect * 0.92));
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height, false);
        measureLabels();
      };
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(mount);
      resize();

      // --- frame ----------------------------------------------------------------------
      const up = new THREE.Vector3(0, 1, 0);
      const origin = new THREE.Vector3();
      const midpoint = new THREE.Vector3();
      const direction = new THREE.Vector3();
      const worldPosition = new THREE.Vector3();
      const projected = new THREE.Vector3();

      const draw = (elapsed: number) => {
        markGroup.rotation.y = Math.sin(elapsed * 0.42) * 0.32;
        markGroup.rotation.z = Math.sin(elapsed * 0.31) * 0.06;
        orbit.rotation.y = elapsed * 0.16;

        const rect = mount.getBoundingClientRect();

        spokes.forEach((spoke, index) => {
          // Link: from the mark at the origin out to the client node. Orienting a cylinder
          // means rotating its +Y onto the direction and scaling its height to the distance.
          direction.copy(spoke.node.position).sub(origin);
          const length = direction.length();
          midpoint.copy(spoke.node.position).multiplyScalar(0.5);
          spoke.link.position.copy(midpoint);
          spoke.link.scale.set(1, length, 1);
          spoke.link.quaternion.setFromUnitVectors(
            up,
            direction.clone().normalize(),
          );

          // Traffic. Alternating direction per spoke, because the point of the product is
          // that the channel runs both ways.
          const t = (elapsed * 0.34 + spoke.phase) % 1;
          const travel = index % 2 === 0 ? t : 1 - t;
          spoke.pulse.position.copy(spoke.node.position).multiplyScalar(travel);

          // Project the node into the container's coordinates and park the HTML label there.
          const label = labelRefs.current[index];
          if (label) {
            spoke.node.getWorldPosition(worldPosition);
            // Fade the labels on the far side of the orbit so the ring reads as a ring.
            // Read the depth before projecting — `project` mutates the vector in place.
            const behind = worldPosition.z < -0.6;
            // Lift the anchor above the node in *world* space rather than nudging the
            // result in pixels: the offset then shrinks with distance like everything
            // else in the scene, so a label never drifts onto its sphere as it orbits.
            worldPosition.y += LABEL_LIFT;
            projected.copy(worldPosition).project(camera);
            // Keep the label inside the stage. Letting it drift a few pixels off its node
            // near the edge reads better than letting it be cut in half.
            const halfWidth = labelHalfWidths[index] ?? 0;
            const x = Math.min(
              Math.max((projected.x * 0.5 + 0.5) * rect.width, halfWidth + 2),
              Math.max(rect.width - halfWidth - 2, halfWidth + 2),
            );
            const y = (-projected.y * 0.5 + 0.5) * rect.height;
            label.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
            label.style.opacity = behind ? "0.35" : "1";
          }
        });

        renderer.render(scene, camera);
      };

      let frameId = 0;
      let running = false;
      // Seconds of animation actually played, accumulated per frame rather than read off a
      // wall clock: pausing for a hidden tab then has no effect on the phase, so the scene
      // resumes where it stopped instead of snapping forward by the time spent hidden.
      // (THREE.Clock would do the wall-clock version, and is deprecated in this version.)
      let playhead = 0;
      let lastFrame = 0;

      const loop = () => {
        const now = performance.now();
        playhead += (now - lastFrame) / 1000;
        lastFrame = now;
        draw(playhead);
        frameId = window.requestAnimationFrame(loop);
      };

      const start = () => {
        if (running || motionQuery.matches) return;
        running = true;
        lastFrame = performance.now();
        loop();
      };
      const stop = () => {
        if (!running) return;
        running = false;
        window.cancelAnimationFrame(frameId);
      };

      // From here the labels are placed by `draw`, so they can leave normal flow.
      labelListRef.current?.setAttribute("data-projected", "true");
      measureLabels(); // re-measure now they are out of flow, before the first placement

      if (motionQuery.matches) {
        // Reduced motion: one composed frame, no animation loop at all.
        draw(1.6);
      } else {
        start();
      }

      // Don't burn a GPU loop on a tab nobody is looking at.
      const onVisibility = () => (document.hidden ? stop() : start());
      document.addEventListener("visibilitychange", onVisibility);

      const onScheme = (event: MediaQueryListEvent) => {
        palette = event.matches ? DARK : LIGHT;
        markMaterial.color.setHex(palette.mark);
        clientMaterial.color.setHex(palette.client);
        linkMaterial.color.setHex(palette.link);
        pulseMaterial.color.setHex(palette.pulse);
        if (!running) draw(1.6); // repaint the static frame under reduced motion
      };
      schemeQuery.addEventListener("change", onScheme);

      teardown = () => {
        stop();
        labelListRef.current?.removeAttribute("data-projected");
        document.removeEventListener("visibilitychange", onVisibility);
        schemeQuery.removeEventListener("change", onScheme);
        resizeObserver.disconnect();
        renderer.domElement.remove();
        renderer.dispose();
        [nodeGeometry, linkGeometry, pulseGeometry, mark.geometry].forEach((g) =>
          g.dispose(),
        );
        [markMaterial, clientMaterial, linkMaterial, pulseMaterial].forEach((m) =>
          m.dispose(),
        );
      };
    })();

    return () => {
      disposed = true;
      teardown?.();
    };
  }, []);

  return (
    <div className={styles.stage}>
      <div ref={mountRef} className={styles.canvas} aria-hidden="true" />
      {/* Real text, not sprites. Until the scene reports itself running the list stays in
          normal flow as a legible row, so a browser with WebGL blocked — or one that never
          runs the effect at all — still shows which clients connect. `data-projected` is what
          the scene sets once it can place each label over its node. */}
      <ul
        ref={labelListRef}
        className={styles.labels}
        aria-label="AI clients Looped In connects to"
      >
        {CLIENTS.map((client, index) => (
          <li
            key={client.id}
            className={styles.label}
            ref={(node) => {
              labelRefs.current[index] = node;
            }}
          >
            {client.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

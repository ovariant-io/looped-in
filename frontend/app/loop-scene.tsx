"use client";

import { useEffect, useRef } from "react";
import { PALETTE_EVENT } from "./lib/palette";
import styles from "./loop-scene.module.css";

/**
 * The landing page's 3D centrepiece: the Looped In mark alone, in a slow tumble on all
 * three axes.
 *
 * The mark is not a decorative stand-in — it is the brand mark's own geometry revolved
 * into three dimensions. The lockup's "OO" is two circles of radius 47 whose centres sit
 * 176 apart, bridged by a concave fillet of radius 75 tangent to both. Sweeping that exact
 * silhouette around its long axis gives two spheres joined by a hyperboloid neck, which is
 * what {@link markProfile} builds. Change a number there and it stops being the logo.
 *
 * Two things are deliberate:
 *
 * - **`three` is imported dynamically.** It is ~600 KB and nothing above the fold needs it,
 *   so it loads after hydration rather than blocking first paint.
 * - **The palette is read from CSS, not held here.** The mark's colour is the computed
 *   value of `--li-scene-mark`, so the token is stated once in globals.css instead of
 *   duplicated as a hex in this file — and the colour picker re-themes the scene for
 *   free, since it moves the same token.
 */

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

/**
 * The mark's colour, read off the document's computed custom properties.
 *
 * globals.css owns the token, so the colour picker's rewrites reach the WebGL material
 * through the same channel as every CSS surface. The fallback is the shipped brand
 * indigo, for the case where the token resolves to nothing (a stylesheet that has not
 * applied yet).
 */
function readMarkColour(): string {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--li-scene-mark")
      .trim() || "#4e67b1"
  );
}

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
        // scene — the lockup and the CTAs are all real DOM — so this stays silent.
        return;
      }

      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      mount.appendChild(renderer.domElement);

      // --- the mark ------------------------------------------------------------------
      const markMaterial = new THREE.MeshStandardMaterial({
        color: readMarkColour(),
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

      const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
      keyLight.position.set(2.6, 3.4, 4.2);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0xffffff, 0.7);
      fillLight.position.set(-3.2, -1.4, 2.0);
      scene.add(fillLight);
      scene.add(new THREE.AmbientLight(0xffffff, 1.25));

      // --- responsive framing ---------------------------------------------------------
      // The tumble can point the mark's long axis anywhere, so what has to stay in frame
      // is its bounding sphere. The left sphere's centre sits one radius in from the end
      // (47 = 47), so the silhouette spans the full length and the bounding radius is
      // exactly half of it. Framing is solved from whichever axis is tighter, so the
      // subject fills the stage at any aspect.
      const FIT_HALF_EXTENT = (MARK.length / 2) * SCALE + 0.15;

      const resize = () => {
        const rect = mount.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        camera.aspect = width / height;

        const halfFov = (camera.fov * Math.PI) / 360;
        const forHeight = FIT_HALF_EXTENT / Math.tan(halfFov);
        const forWidth = FIT_HALF_EXTENT / (Math.tan(halfFov) * camera.aspect);
        camera.position.set(0, 0.55, Math.max(forHeight, forWidth) * 1.08);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height, false);
      };
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(mount);
      resize();

      // --- frame ----------------------------------------------------------------------
      const draw = (elapsed: number) => {
        // A gradual tumble: constant rates on all three axes, deliberately incommensurate
        // so the pose keeps changing without ever visibly looping.
        markGroup.rotation.x = elapsed * 0.16;
        markGroup.rotation.y = elapsed * 0.24;
        markGroup.rotation.z = elapsed * 0.1;
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

      if (motionQuery.matches) {
        // Reduced motion: one composed frame, no animation loop at all.
        draw(1.6);
      } else {
        start();
      }

      // Don't burn a GPU loop on a tab nobody is looking at.
      const onVisibility = () => (document.hidden ? stop() : start());
      document.addEventListener("visibilitychange", onVisibility);

      // Re-read the token whenever it could have moved: the OS scheme flipping, or the
      // colour picker rewriting the custom properties. Both land in the same place, so
      // there is one handler rather than one per source.
      const onPalette = () => {
        markMaterial.color.setStyle(readMarkColour());
        if (!running) draw(1.6); // repaint the static frame under reduced motion
      };
      schemeQuery.addEventListener("change", onPalette);
      window.addEventListener(PALETTE_EVENT, onPalette);

      teardown = () => {
        stop();
        document.removeEventListener("visibilitychange", onVisibility);
        schemeQuery.removeEventListener("change", onPalette);
        window.removeEventListener(PALETTE_EVENT, onPalette);
        resizeObserver.disconnect();
        renderer.domElement.remove();
        renderer.dispose();
        mark.geometry.dispose();
        markMaterial.dispose();
      };
    })();

    return () => {
      disposed = true;
      teardown?.();
    };
  }, []);

  return (
    <div className={styles.stage} aria-hidden="true">
      <div ref={mountRef} className={styles.canvas} />
    </div>
  );
}

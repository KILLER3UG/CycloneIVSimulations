// materials.js — PBR material set + lighting for the board scene.
// Board material colours never change with theme; only background/ground do.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export function createMaterials() {
    const physical = (opts) => new THREE.MeshPhysicalMaterial(opts);

    return {
        // PCB (map is assigned by pcb.js silkscreen atlas). The real board is a
        // deep matte black with a faint sheen — keep metalness low so the
        // environment doesn't wash it towards grey.
        pcbTop: physical({
            color: 0xffffff, roughness: 0.56, metalness: 0.06,
            clearcoat: 0.28, clearcoatRoughness: 0.6, envMapIntensity: 0.38,
        }),
        pcbSide: new THREE.MeshStandardMaterial({ color: 0x08090b, roughness: 0.75, metalness: 0.05 }),

        // metals
        gold: physical({ color: 0xd8b04a, metalness: 1.0, roughness: 0.28, envMapIntensity: 1.15 }),
        goldDark: physical({ color: 0xa8842e, metalness: 1.0, roughness: 0.4, envMapIntensity: 0.9 }),
        brass: physical({ color: 0xb99244, metalness: 1.0, roughness: 0.34, envMapIntensity: 1.0 }),
        silver: physical({ color: 0xc9cdd2, metalness: 1.0, roughness: 0.3, envMapIntensity: 1.1 }),
        steel: physical({ color: 0x9aa0a6, metalness: 0.9, roughness: 0.42, envMapIntensity: 0.9 }),

        // plastics / epoxy
        plasticBlack: physical({ color: 0x15171a, roughness: 0.5, metalness: 0.05, clearcoat: 0.25, clearcoatRoughness: 0.5 }),
        // EQFP packages read dark grey (lighter than the PCB) in the photos
        chipBlack: physical({ color: 0x1a1c20, roughness: 0.38, metalness: 0.06, clearcoat: 0.5, clearcoatRoughness: 0.38 }),
        plasticWhite: physical({ color: 0xe9e7df, roughness: 0.5, metalness: 0.0 }),
        // photo headers are saturated warm yellow
        headerYellow: physical({ color: 0xf0c11c, roughness: 0.52, metalness: 0.0 }),
        red: physical({ color: 0xc42b1f, roughness: 0.42, metalness: 0.0, clearcoat: 0.4, clearcoatRoughness: 0.4 }),
        // VGA hood: vivid medium blue (vendor photo)
        blue: physical({ color: 0x1a6ad0, roughness: 0.42, metalness: 0.0, clearcoat: 0.4, clearcoatRoughness: 0.35 }),
        darkEpoxy: physical({ color: 0x24272b, roughness: 0.5, metalness: 0.02 }),

        // passives
        resistor: new THREE.MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.55, metalness: 0.1 }),
        capacitor: new THREE.MeshStandardMaterial({ color: 0x9a7b4f, roughness: 0.55, metalness: 0.05 }),
        // photo tantalums are bright yellow-orange
        tantalum: physical({ color: 0xd69a1e, roughness: 0.45, metalness: 0.1 }),
        electrolytic: physical({ color: 0x171a1e, roughness: 0.4, metalness: 0.15, clearcoat: 0.3 }),
        // tact-key actuator caps: near-black round buttons on silver shells
        keyCap: physical({ color: 0x1f2226, roughness: 0.42, metalness: 0.05, clearcoat: 0.5, clearcoatRoughness: 0.3 }),

        // emissives (per-instance clones where needed)
        ledLens: physical({
            color: 0xffd6d6, roughness: 0.18, metalness: 0.0, transparent: true, opacity: 0.92,
            clearcoat: 0.8, clearcoatRoughness: 0.2, emissive: 0xff1111, emissiveIntensity: 0,
        }),
        segmentBase: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    };
}

const THEME = {
    dark: {
        background: 0x0d1014,
        ground: 0x14181d,
        groundRoughness: 0.95,
        hemi: 0.55,
        fog: { color: 0x0d1014, near: 260, far: 900 },
    },
    light: {
        background: 0xe3ded4, // photo-studio tan, like the reference shot
        ground: 0xd8d2c6,
        groundRoughness: 0.9,
        hemi: 0.75,
        fog: { color: 0xe3ded4, near: 260, far: 900 },
    },
};

export function setupEnvironment(renderer, scene) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    scene.environment = env;
    pmrem.dispose();
    return env;
}

export function setupLights(scene, quality) {
    const hemi = new THREE.HemisphereLight(0x9fb4c8, 0x20242a, 0.55);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff1de, 2.6);
    key.position.set(70, 150, 60);
    key.castShadow = quality !== "performance";
    const shadowSize = quality === "high" ? 2048 : 1024;
    key.shadow.mapSize.set(shadowSize, shadowSize);
    key.shadow.camera.left = -120;
    key.shadow.camera.right = 120;
    key.shadow.camera.top = 120;
    key.shadow.camera.bottom = -120;
    key.shadow.camera.near = 20;
    key.shadow.camera.far = 420;
    key.shadow.bias = -0.00035;
    key.shadow.normalBias = 0.6;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xc7d8ff, 0.7);
    fill.position.set(-90, 70, -50);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xaec4ff, 0.85);
    rim.position.set(-50, 90, 120);
    scene.add(rim);

    const ground = new THREE.Mesh(
        new THREE.CircleGeometry(700, 64),
        new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.95, metalness: 0.0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    scene.add(ground);

    return { hemi, key, fill, rim, ground };
}

export function applyTheme(scene, lights, theme) {
    const t = THEME[theme] || THEME.dark;
    scene.background = new THREE.Color(t.background);
    scene.fog = new THREE.Fog(t.fog.color, t.fog.near, t.fog.far);
    if (lights) {
        if (lights.ground) {
            lights.ground.material.color.setHex(t.ground);
            lights.ground.material.roughness = t.groundRoughness;
        }
        if (lights.hemi) lights.hemi.intensity = t.hemi;
    }
    return t;
}

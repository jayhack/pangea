import * as THREE from "three";
import "./style.css";

type ActionName = "punch" | "kick" | "jump";
type AttackName = Exclude<ActionName, "jump">;

interface AttackDefinition {
  duration: number;
  strikeAt: number;
  reach: number;
  height: number;
  color: string;
}

interface ActiveAttack {
  type: AttackName;
  elapsed: number;
  emittedStrike: boolean;
}

interface StrikeEvent {
  type: AttackName;
  origin: THREE.Vector3;
  yaw: number;
}

interface FighterUpdateResult {
  startedActions: ActionName[];
  strike?: StrikeEvent;
}

interface MovementInput {
  forward: number;
  turn: number;
}

interface WorldSpec {
  terrain: {
    size: number;
    segments: number;
  };
  trees: {
    count: number;
    minRadiusFromSpawn: number;
  };
}

const WORLD_SPEC: WorldSpec = {
  terrain: {
    size: 132,
    segments: 160,
  },
  trees: {
    count: 92,
    minRadiusFromSpawn: 9,
  },
};

const ATTACKS: Record<AttackName, AttackDefinition> = {
  punch: {
    duration: 0.42,
    strikeAt: 0.42,
    reach: 0.95,
    height: 1.25,
    color: "#f0b84f",
  },
  kick: {
    duration: 0.58,
    strikeAt: 0.52,
    reach: 1.08,
    height: 0.48,
    color: "#61d4bf",
  },
};

const canvas = document.querySelector<HTMLCanvasElement>("#game");

if (!canvas) {
  throw new Error("Missing #game canvas");
}

const scene = new THREE.Scene();
scene.background = new THREE.Color("#93bfdc");
scene.fog = new THREE.FogExp2("#93bfdc", 0.012);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.03;

const clock = new THREE.Clock();
const smoothedCameraTarget = new THREE.Vector3(0, 1.3, 0);

const actionChips: Record<ActionName, HTMLElement | null> = {
  punch: document.querySelector<HTMLElement>("#punch-chip"),
  kick: document.querySelector<HTMLElement>("#kick-chip"),
  jump: document.querySelector<HTMLElement>("#jump-chip"),
};

const chipTimers: Partial<Record<ActionName, number>> = {};

function pulseActionChip(action: ActionName): void {
  document.documentElement.dataset.lastAction = action;
  document.documentElement.dataset.lastActionAt = performance.now().toFixed(1);

  const chip = actionChips[action];

  if (!chip) {
    return;
  }

  if (chipTimers[action] !== undefined) {
    window.clearTimeout(chipTimers[action]);
  }

  chip.classList.add("is-active");
  chipTimers[action] = window.setTimeout(() => {
    chip.classList.remove("is-active");
  }, action === "kick" ? 310 : 220);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function terrainHeight(x: number, z: number): number {
  const distance = Math.hypot(x, z);
  const openSpawn = 0.24 + smoothstep(4, 18, distance) * 0.76;
  const rollingHills =
    Math.sin(x * 0.14) * 0.48 +
    Math.cos(z * 0.13) * 0.52 +
    Math.sin((x + z) * 0.071) * 0.72 +
    Math.cos((x - z) * 0.052) * 0.34;
  const detail = Math.sin(x * 0.37 + z * 0.16) * 0.12 + Math.cos(z * 0.31) * 0.09;
  const outerRise = smoothstep(32, 62, distance) * 0.65;

  return (rollingHills + detail) * openSpawn + outerRise - 0.12;
}

function seededRandom(seed: number): () => number {
  let state = seed;

  return () => {
    state += 0x6d2b79f5;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRange(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

function setSegment(mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3, radius: number): void {
  const direction = end.clone().sub(start);
  const length = direction.length();

  if (length < 0.001) {
    mesh.visible = false;
    return;
  }

  mesh.visible = true;
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.scale.set(radius, length, radius);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
}

class InputController {
  private readonly keys = new Set<string>();
  private jumpQueued = false;
  private punchQueued = false;
  private kickQueued = false;

  constructor(targetCanvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (event) => {
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
        event.preventDefault();
      }

      if (!event.repeat) {
        if (event.code === "Space" || event.code === "KeyD") {
          this.jumpQueued = true;
        }

        if (event.code === "KeyA" || event.code === "KeyJ" || event.code === "KeyF") {
          this.punchQueued = true;
        }

        if (event.code === "KeyS" || event.code === "KeyK" || event.code === "KeyG") {
          this.kickQueued = true;
        }
      }

      this.keys.add(event.code);
    });

    window.addEventListener("keyup", (event) => {
      this.keys.delete(event.code);
    });

    targetCanvas.addEventListener("pointerdown", (event) => {
      targetCanvas.focus();

      if (event.button === 0) {
        this.punchQueued = true;
      }

      if (event.button === 2) {
        this.kickQueued = true;
      }
    });

    targetCanvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
  }

  movement(): MovementInput {
    let forward = 0;
    let turn = 0;

    if (this.keys.has("ArrowLeft")) {
      turn -= 1;
    }

    if (this.keys.has("ArrowRight")) {
      turn += 1;
    }

    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) {
      forward += 1;
    }

    if (this.keys.has("ArrowDown")) {
      forward -= 1;
    }

    return {
      forward: clamp(forward, -1, 1),
      turn: clamp(turn, -1, 1),
    };
  }

  consumeJump(): boolean {
    const queued = this.jumpQueued;
    this.jumpQueued = false;
    return queued;
  }

  consumePunch(): boolean {
    const queued = this.punchQueued;
    this.punchQueued = false;
    return queued;
  }

  consumeKick(): boolean {
    const queued = this.kickQueued;
    this.kickQueued = false;
    return queued;
  }
}

class StickFighter {
  readonly group = new THREE.Group();

  position = new THREE.Vector3(0, terrainHeight(0, 0), 0);
  yaw = 0;

  private readonly horizontalVelocity = new THREE.Vector3();
  private readonly targetVelocity = new THREE.Vector3();
  private readonly segmentGeometry = new THREE.CylinderGeometry(1, 1, 1, 12);
  private readonly sphereGeometry = new THREE.SphereGeometry(1, 18, 14);
  private readonly stickMaterial = new THREE.MeshStandardMaterial({
    color: "#050505",
    roughness: 0.72,
    metalness: 0.03,
  });
  private readonly segments = new Map<string, THREE.Mesh>();
  private readonly nodes = new Map<string, THREE.Mesh>();
  private verticalVelocity = 0;
  private jumpsUsed = 0;
  private onGround = true;
  private animationTime = 0;
  private activeAttack: ActiveAttack | null = null;
  private bufferedAttack: AttackName | null = null;
  private bufferedAttackTime = 0;

  constructor() {
    this.group.position.copy(this.position);

    [
      "torso",
      "shoulders",
      "leftUpperArm",
      "leftForearm",
      "rightUpperArm",
      "rightForearm",
      "leftUpperLeg",
      "leftLowerLeg",
      "rightUpperLeg",
      "rightLowerLeg",
    ].forEach((name) => this.addSegment(name));

    [
      ["head", 0.18],
      ["leftFist", 0.085],
      ["rightFist", 0.085],
      ["leftFoot", 0.095],
      ["rightFoot", 0.095],
    ].forEach(([name, scale]) => this.addNode(String(name), Number(scale)));

    this.updateSkeleton(0);
  }

  update(input: InputController, deltaTime: number): FighterUpdateResult {
    const startedActions: ActionName[] = [];
    const movement = input.movement();
    const turnSpeed = 2.35;
    const moveSpeed = movement.forward >= 0 ? 6.15 : 3.65;
    const airControl = this.onGround ? 18 : 7;
    const targetVelocity = this.targetVelocity.set(0, 0, 0);

    if (movement.turn !== 0) {
      this.yaw += movement.turn * turnSpeed * deltaTime;
      this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    }

    if (movement.forward !== 0) {
      targetVelocity.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(movement.forward * moveSpeed);
    }

    this.horizontalVelocity.x = THREE.MathUtils.damp(
      this.horizontalVelocity.x,
      targetVelocity.x,
      movement.forward === 0 ? 12 : airControl,
      deltaTime,
    );
    this.horizontalVelocity.z = THREE.MathUtils.damp(
      this.horizontalVelocity.z,
      targetVelocity.z,
      movement.forward === 0 ? 12 : airControl,
      deltaTime,
    );

    if (input.consumeJump() && this.jumpsUsed < 2) {
      this.verticalVelocity = this.jumpsUsed === 0 ? 8.2 : 7.05;
      this.jumpsUsed += 1;
      this.onGround = false;
      startedActions.push("jump");
    }

    if (this.bufferedAttackTime > 0) {
      this.bufferedAttackTime -= deltaTime;

      if (this.bufferedAttackTime <= 0) {
        this.bufferedAttack = null;
      }
    }

    if (input.consumePunch()) {
      this.requestAttack("punch", startedActions);
    }

    if (input.consumeKick()) {
      this.requestAttack("kick", startedActions);
    }

    this.position.x += this.horizontalVelocity.x * deltaTime;
    this.position.z += this.horizontalVelocity.z * deltaTime;

    const worldLimit = WORLD_SPEC.terrain.size * 0.47;
    this.position.x = clamp(this.position.x, -worldLimit, worldLimit);
    this.position.z = clamp(this.position.z, -worldLimit, worldLimit);

    this.verticalVelocity -= 20.5 * deltaTime;
    this.position.y += this.verticalVelocity * deltaTime;

    const groundHeight = terrainHeight(this.position.x, this.position.z);

    if (this.position.y <= groundHeight) {
      this.position.y = groundHeight;
      this.verticalVelocity = 0;
      this.jumpsUsed = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    const horizontalSpeed = Math.hypot(this.horizontalVelocity.x, this.horizontalVelocity.z);
    this.animationTime += deltaTime * (3.2 + horizontalSpeed * 0.55);

    const strike = this.updateAttack(deltaTime);

    if (!this.activeAttack && this.bufferedAttack && this.bufferedAttackTime > 0) {
      const bufferedAttack = this.bufferedAttack;
      this.bufferedAttack = null;
      this.bufferedAttackTime = 0;

      if (this.startAttack(bufferedAttack)) {
        startedActions.push(bufferedAttack);
      }
    }

    this.group.position.copy(this.position);
    this.group.rotation.y = this.yaw;
    this.updateSkeleton(horizontalSpeed);

    return { startedActions, strike };
  }

  private addSegment(name: string): void {
    const mesh = new THREE.Mesh(this.segmentGeometry, this.stickMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.segments.set(name, mesh);
  }

  private addNode(name: string, scale: number): void {
    const mesh = new THREE.Mesh(this.sphereGeometry, this.stickMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.scale.setScalar(scale);
    this.group.add(mesh);
    this.nodes.set(name, mesh);
  }

  private startAttack(type: AttackName): boolean {
    if (this.activeAttack) {
      return false;
    }

    this.activeAttack = {
      type,
      elapsed: 0,
      emittedStrike: false,
    };

    return true;
  }

  private requestAttack(type: AttackName, startedActions: ActionName[]): void {
    if (this.startAttack(type)) {
      startedActions.push(type);
      return;
    }

    this.bufferedAttack = type;
    this.bufferedAttackTime = 0.75;
  }

  private updateAttack(deltaTime: number): StrikeEvent | undefined {
    if (!this.activeAttack) {
      return undefined;
    }

    const attack = ATTACKS[this.activeAttack.type];
    this.activeAttack.elapsed += deltaTime;

    let strike: StrikeEvent | undefined;
    const progress = this.activeAttack.elapsed / attack.duration;

    if (!this.activeAttack.emittedStrike && progress >= attack.strikeAt) {
      this.activeAttack.emittedStrike = true;
      const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      strike = {
        type: this.activeAttack.type,
        yaw: this.yaw,
        origin: this.position
          .clone()
          .add(new THREE.Vector3(0, attack.height, 0))
          .addScaledVector(forward, attack.reach),
      };
    }

    if (this.activeAttack.elapsed >= attack.duration) {
      this.activeAttack = null;
    }

    return strike;
  }

  private updateSkeleton(horizontalSpeed: number): void {
    const speed01 = clamp(horizontalSpeed / 6.15, 0, 1);
    const stride = Math.sin(this.animationTime * 2.6) * speed01;
    const bob = this.onGround ? Math.abs(Math.sin(this.animationTime * 2.6)) * 0.045 * speed01 : 0;
    const airborne = this.onGround ? 0 : 1;
    const attack = this.activeAttack;
    const punchProgress = attack?.type === "punch" ? attack.elapsed / ATTACKS.punch.duration : 0;
    const kickProgress = attack?.type === "kick" ? attack.elapsed / ATTACKS.kick.duration : 0;
    const punchReach = punchProgress > 0 ? Math.sin(Math.PI * clamp(punchProgress, 0, 1)) : 0;
    const kickReach = kickProgress > 0 ? Math.sin(Math.PI * clamp(kickProgress, 0, 1)) : 0;
    const torsoLean = punchReach * 0.05 - kickReach * 0.1;

    const hip = new THREE.Vector3(0, 0.82 + bob, -torsoLean);
    const chest = new THREE.Vector3(0, 1.48 + bob, torsoLean);
    const neck = new THREE.Vector3(0, 1.72 + bob, torsoLean * 0.55);
    const head = new THREE.Vector3(0, 1.96 + bob, torsoLean * 0.5);
    const leftShoulder = new THREE.Vector3(-0.27, 1.49 + bob, torsoLean * 0.45);
    const rightShoulder = new THREE.Vector3(0.27, 1.49 + bob, torsoLean * 0.45);
    const leftHip = new THREE.Vector3(-0.15, 0.82 + bob, -torsoLean);
    const rightHip = new THREE.Vector3(0.15, 0.82 + bob, -torsoLean);

    const leftHand = new THREE.Vector3(-0.39, 1.02 + bob, -stride * 0.2);
    const rightHand = new THREE.Vector3(0.39, 1.02 + bob, stride * 0.2);
    const leftElbow = leftShoulder.clone().lerp(leftHand, 0.56).add(new THREE.Vector3(-0.09, 0.02, 0));
    const rightElbow = rightShoulder.clone().lerp(rightHand, 0.56).add(new THREE.Vector3(0.09, 0.02, 0));

    if (punchReach > 0) {
      rightHand.set(0.23, 1.28 + bob, 0.2 + punchReach * 0.67);
      rightElbow.set(0.28, 1.33 + bob, 0.1 + punchReach * 0.35);
      leftHand.set(-0.38, 1.25 + bob, -0.12);
      leftElbow.set(-0.3, 1.34 + bob, -0.04);
    }

    if (kickReach > 0) {
      leftHand.set(-0.34, 1.28 + bob, -0.08);
      rightHand.set(0.34, 1.23 + bob, -0.18);
      leftElbow.set(-0.3, 1.37 + bob, -0.02);
      rightElbow.set(0.3, 1.34 + bob, -0.08);
    }

    const tuck = airborne * 0.22;
    const leftFoot = new THREE.Vector3(-0.17, 0.06 + tuck, stride * 0.28 - airborne * 0.08);
    const rightFoot = new THREE.Vector3(0.17, 0.06 + tuck, -stride * 0.28 - airborne * 0.08);
    const leftKnee = new THREE.Vector3(-0.17, 0.45 + tuck * 0.65, stride * 0.16 + 0.08);
    const rightKnee = new THREE.Vector3(0.17, 0.45 + tuck * 0.65, -stride * 0.16 + 0.08);

    if (kickReach > 0) {
      rightFoot.set(0.16, 0.18 + kickReach * 0.36, 0.2 + kickReach * 0.86);
      rightKnee.set(0.16, 0.55 + kickReach * 0.08, 0.08 + kickReach * 0.42);
      leftFoot.set(-0.17, 0.06, -0.09);
      leftKnee.set(-0.17, 0.5, 0.02);
    }

    setSegment(this.segment("torso"), hip, neck, 0.045);
    setSegment(this.segment("shoulders"), leftShoulder, rightShoulder, 0.04);
    setSegment(this.segment("leftUpperArm"), leftShoulder, leftElbow, 0.035);
    setSegment(this.segment("leftForearm"), leftElbow, leftHand, 0.032);
    setSegment(this.segment("rightUpperArm"), rightShoulder, rightElbow, 0.035);
    setSegment(this.segment("rightForearm"), rightElbow, rightHand, 0.032);
    setSegment(this.segment("leftUpperLeg"), leftHip, leftKnee, 0.04);
    setSegment(this.segment("leftLowerLeg"), leftKnee, leftFoot, 0.036);
    setSegment(this.segment("rightUpperLeg"), rightHip, rightKnee, 0.04);
    setSegment(this.segment("rightLowerLeg"), rightKnee, rightFoot, 0.036);

    this.node("head").position.copy(head);
    this.node("leftFist").position.copy(leftHand);
    this.node("rightFist").position.copy(rightHand);
    this.node("leftFoot").position.copy(leftFoot);
    this.node("rightFoot").position.copy(rightFoot);

    this.node("head").scale.setScalar(0.18 + punchReach * 0.005);
  }

  private segment(name: string): THREE.Mesh {
    const mesh = this.segments.get(name);

    if (!mesh) {
      throw new Error(`Missing segment: ${name}`);
    }

    return mesh;
  }

  private node(name: string): THREE.Mesh {
    const mesh = this.nodes.get(name);

    if (!mesh) {
      throw new Error(`Missing node: ${name}`);
    }

    return mesh;
  }
}

class ImpactEffects {
  private readonly effects: Array<{
    mesh: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
    age: number;
    duration: number;
  }> = [];

  constructor(private readonly parentScene: THREE.Scene) {}

  spawn(strike: StrikeEvent): void {
    const definition = ATTACKS[strike.type];
    const geometry = new THREE.TorusGeometry(strike.type === "kick" ? 0.25 : 0.18, 0.016, 10, 34);
    const material = new THREE.MeshBasicMaterial({
      color: definition.color,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    const forward = new THREE.Vector3(Math.sin(strike.yaw), 0, Math.cos(strike.yaw));

    mesh.position.copy(strike.origin);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), forward.normalize());
    this.parentScene.add(mesh);
    this.effects.push({ mesh, age: 0, duration: 0.36 });
  }

  update(deltaTime: number): void {
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      const effect = this.effects[index];
      effect.age += deltaTime;

      const progress = effect.age / effect.duration;
      const scale = 1 + progress * 1.9;
      effect.mesh.scale.setScalar(scale);
      effect.mesh.material.opacity = (1 - progress) * 0.92;

      if (progress >= 1) {
        this.parentScene.remove(effect.mesh);
        effect.mesh.geometry.dispose();
        effect.mesh.material.dispose();
        this.effects.splice(index, 1);
      }
    }
  }
}

function createTerrain(): THREE.Mesh {
  const { size, segments } = WORLD_SPEC.terrain;
  const halfSize = size / 2;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const lowColor = new THREE.Color("#315f63");
  const meadowColor = new THREE.Color("#4f9a58");
  const goldGrass = new THREE.Color("#b8b35c");
  const highColor = new THREE.Color("#8b948c");
  const random = seededRandom(710);

  for (let zIndex = 0; zIndex <= segments; zIndex += 1) {
    for (let xIndex = 0; xIndex <= segments; xIndex += 1) {
      const x = (xIndex / segments - 0.5) * size;
      const z = (zIndex / segments - 0.5) * size;
      const y = terrainHeight(x, z);
      const color = new THREE.Color();
      const colorNoise = random() * 0.12;

      if (y < -0.72) {
        color.copy(lowColor).lerp(meadowColor, 0.35 + colorNoise);
      } else if (y > 1.12) {
        color.copy(meadowColor).lerp(highColor, clamp((y - 1.12) / 1.1, 0.15, 0.85));
      } else {
        color.copy(meadowColor).lerp(goldGrass, clamp((Math.sin(x * 0.22 + z * 0.14) + 1) * 0.2 + colorNoise, 0, 0.55));
      }

      positions.push(x, y, z);
      colors.push(color.r, color.g, color.b);
    }
  }

  for (let zIndex = 0; zIndex < segments; zIndex += 1) {
    for (let xIndex = 0; xIndex < segments; xIndex += 1) {
      const a = zIndex * (segments + 1) + xIndex;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

function createWater(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(WORLD_SPEC.terrain.size * 0.86, WORLD_SPEC.terrain.size * 0.86, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    color: "#70aeca",
    roughness: 0.24,
    metalness: 0,
    transparent: true,
    opacity: 0.44,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -1.03;
  return mesh;
}

function createTree(x: number, z: number, scale: number, leafColor: THREE.Color): THREE.Group {
  const ground = terrainHeight(x, z);
  const group = new THREE.Group();
  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: "#6a5037",
    roughness: 0.88,
  });
  const leafMaterial = new THREE.MeshStandardMaterial({
    color: leafColor,
    roughness: 0.76,
  });
  const trunkHeight = 1.05 * scale;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * scale, 0.14 * scale, trunkHeight, 7), trunkMaterial);
  trunk.position.set(0, trunkHeight / 2, 0);
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  group.add(trunk);

  const canopyA = new THREE.Mesh(new THREE.ConeGeometry(0.6 * scale, 1.18 * scale, 9), leafMaterial);
  canopyA.position.set(0, trunkHeight + 0.38 * scale, 0);
  canopyA.castShadow = true;
  group.add(canopyA);

  const canopyB = new THREE.Mesh(new THREE.ConeGeometry(0.48 * scale, 0.92 * scale, 9), leafMaterial);
  canopyB.position.set(0.05 * scale, trunkHeight + 0.9 * scale, -0.04 * scale);
  canopyB.castShadow = true;
  group.add(canopyB);

  group.position.set(x, ground, z);
  group.rotation.y = Math.sin(x * 0.23 + z * 0.19) * 0.35;
  return group;
}

function createRock(x: number, z: number, scale: number): THREE.Mesh {
  const geometry = new THREE.DodecahedronGeometry(scale, 0);
  const material = new THREE.MeshStandardMaterial({
    color: "#747c79",
    roughness: 0.86,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, terrainHeight(x, z) + scale * 0.36, z);
  mesh.rotation.set(scale * 2.1, x * 0.04, z * 0.03);
  mesh.scale.y = 0.58;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createWorld(): THREE.Group {
  const world = new THREE.Group();
  const random = seededRandom(8843);
  const leafPalette = [new THREE.Color("#2f7d4a"), new THREE.Color("#3f8a5a"), new THREE.Color("#647f3f")];

  world.add(createTerrain());
  world.add(createWater());

  let placedTrees = 0;
  let attempts = 0;

  while (placedTrees < WORLD_SPEC.trees.count && attempts < WORLD_SPEC.trees.count * 12) {
    attempts += 1;
    const radius = randomRange(random, WORLD_SPEC.trees.minRadiusFromSpawn, WORLD_SPEC.terrain.size * 0.46);
    const angle = randomRange(random, 0, Math.PI * 2);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const height = terrainHeight(x, z);

    if (height < -0.72 || Math.abs(x) > WORLD_SPEC.terrain.size * 0.48 || Math.abs(z) > WORLD_SPEC.terrain.size * 0.48) {
      continue;
    }

    const scale = randomRange(random, 0.75, 1.55);
    const leafColor = leafPalette[Math.floor(random() * leafPalette.length)].clone();
    leafColor.offsetHSL(randomRange(random, -0.025, 0.025), randomRange(random, -0.06, 0.06), randomRange(random, -0.06, 0.04));
    world.add(createTree(x, z, scale, leafColor));
    placedTrees += 1;
  }

  for (let index = 0; index < 34; index += 1) {
    const radius = randomRange(random, 7, WORLD_SPEC.terrain.size * 0.44);
    const angle = randomRange(random, 0, Math.PI * 2);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    if (terrainHeight(x, z) > -0.7) {
      world.add(createRock(x, z, randomRange(random, 0.18, 0.48)));
    }
  }

  return world;
}

function addLighting(): void {
  const hemiLight = new THREE.HemisphereLight("#d6efff", "#5d6b42", 1.45);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight("#fff3d6", 2.75);
  keyLight.position.set(-14, 22, -10);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 80;
  keyLight.shadow.camera.left = -34;
  keyLight.shadow.camera.right = 34;
  keyLight.shadow.camera.top = 34;
  keyLight.shadow.camera.bottom = -34;
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight("#bde8ff", 0.92);
  rimLight.position.set(16, 10, 16);
  scene.add(rimLight);
}

function updateCamera(fighter: StickFighter, deltaTime: number): void {
  const forward = new THREE.Vector3(Math.sin(fighter.yaw), 0, Math.cos(fighter.yaw));
  const target = fighter.position.clone().add(new THREE.Vector3(0, 1.32, 0)).addScaledVector(forward, 0.95);
  const desiredPosition = fighter.position
    .clone()
    .addScaledVector(forward, -7.2)
    .add(new THREE.Vector3(0, 3.6, 0));

  desiredPosition.y = Math.max(desiredPosition.y, terrainHeight(desiredPosition.x, desiredPosition.z) + 1.5);
  camera.position.lerp(desiredPosition, 1 - Math.exp(-5.8 * deltaTime));
  smoothedCameraTarget.lerp(target, 1 - Math.exp(-8.5 * deltaTime));
  camera.lookAt(smoothedCameraTarget);
}

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

addLighting();

const input = new InputController(canvas);
const fighter = new StickFighter();
const effects = new ImpactEffects(scene);

scene.add(createWorld());
scene.add(fighter.group);
camera.position.set(0, 3.8, -7.6);
updateCamera(fighter, 1);

window.addEventListener("resize", resize);

function frame(): void {
  const deltaTime = Math.min(clock.getDelta(), 1 / 30);
  const result = fighter.update(input, deltaTime);

  document.documentElement.dataset.playerYaw = fighter.yaw.toFixed(4);
  result.startedActions.forEach(pulseActionChip);

  if (result.strike) {
    effects.spawn(result.strike);
  }

  effects.update(deltaTime);
  updateCamera(fighter, deltaTime);
  renderer.render(scene, camera);
  window.requestAnimationFrame(frame);
}

frame();

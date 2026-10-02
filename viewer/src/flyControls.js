import * as THREE from 'three';

/**
 * Free-fly camera, Unity scene-view style:
 * drag to look, WASD to move on the horizontal plane (looking up/down doesn't change height),
 * Space/E up, Shift/Q down, Ctrl (or Alt) to sprint, -/= to change the base speed.
 * The mouse wheel is left to the caller (field of view).
 */
export class FlyControls {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.enabled = true;
    this.speed = 120; // units per second
    this.lookSensitivity = 0.0025;
    this.onSpeedChange = null;
    this.onWheel = null; // (deltaY) => void

    this.keys = new Set();
    this.dragging = false;
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.velocity = new THREE.Vector3();
    this.clock = new THREE.Clock();

    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      this.dragging = true;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointerup', (e) => {
      this.dragging = false;
      dom.releasePointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.enabled || !this.dragging) return;
      this.euler.setFromQuaternion(camera.quaternion);
      this.euler.y -= e.movementX * this.lookSensitivity;
      this.euler.x -= e.movementY * this.lookSensitivity;
      this.euler.x = THREE.MathUtils.clamp(this.euler.x, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
      camera.quaternion.setFromEuler(this.euler);
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.onWheel?.(e.deltaY);
      },
      { passive: false },
    );
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return; // typing in the GUI
      if (e.code === 'Space') e.preventDefault(); // don't scroll / click focused GUI buttons
      if (this.enabled && e.ctrlKey && /^Key[WASDQE]$/.test(e.code)) e.preventDefault(); // sprinting, not shortcuts
      if (this.enabled && ['Minus', 'NumpadSubtract', 'Equal', 'NumpadAdd'].includes(e.code)) {
        const up = e.code === 'Equal' || e.code === 'NumpadAdd';
        this.speed = THREE.MathUtils.clamp(this.speed * (up ? 1.25 : 0.8), 5, 3000);
        this.onSpeedChange?.(this.speed);
      }
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  lookAt(target) {
    this.camera.lookAt(target);
  }

  update() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (!this.enabled) return;
    const k = this.keys;
    const dir = new THREE.Vector3(
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0),
      (k.has('Space') || k.has('KeyE') ? 1 : 0) - (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyQ') ? 1 : 0),
      (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0),
    );
    const boost = k.has('ControlLeft') || k.has('ControlRight') || k.has('AltLeft') || k.has('AltRight') ? 4 : 1; // sprint
    // Smooth acceleration so movement doesn't feel jerky
    const target = dir.normalize().multiplyScalar(this.speed * boost);
    this.velocity.lerp(target, 1 - Math.exp(-dt * 12));
    if (this.velocity.lengthSq() < 1e-4) return;
    const move = this.velocity.clone().multiplyScalar(dt);
    // WASD follows the view's heading only (yaw), so pitch never changes altitude
    const yaw = this.euler.setFromQuaternion(this.camera.quaternion).y;
    move.applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    this.camera.position.add(move);
  }
}

// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// three.js preview of the generated solid. Model data is z-up (mm); the scene
// rotates it into three.js's y-up world for display.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

export class Viewer3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14181d);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(140, 120, 140);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;

    const hemi = new THREE.HemisphereLight(0xdde7ff, 0x30281e, 1.1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(120, 220, 160);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xaabbdd, 0.5);
    dir2.position.set(-150, 80, -120);
    this.scene.add(dir2);

    this.grid = new THREE.GridHelper(300, 30, 0x3a4450, 0x242c35);
    this.scene.add(this.grid);

    this.mesh = null;
    this.material = new THREE.MeshStandardMaterial({
      color: 0x4f8fd4, metalness: 0.05, roughness: 0.55, flatShading: true,
      side: THREE.DoubleSide,
    });

    this._raf = null;
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.resize();
    this._animate();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _animate() {
    this._raf = requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // meshData: { positions (z-up mm), indices }
  setMesh(meshData, fitView = false) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (!meshData) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    geo.computeVertexNormals();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.rotation.x = -Math.PI / 2; // model z-up -> scene y-up
    this.scene.add(this.mesh);

    if (fitView) this.fit(meshData);
  }

  fit(meshData) {
    const s = meshData.stats;
    const span = Math.max(s.sizeX, s.sizeY, s.sizeZ, 10);
    const d = span * 1.9;
    this.camera.position.set(d * 0.8, d * 0.75, d * 0.8);
    this.controls.target.set(0, s.sizeZ / 2, 0);
    this.controls.update();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._resize);
    this.renderer.dispose();
  }
}

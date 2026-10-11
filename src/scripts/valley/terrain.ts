import * as THREE from 'three';

// Native valley palette and the terrain benchmark's fixed mesh/camera presets.
export const PALETTE = [0x0a1626, 0x123b66, 0x2e6db4, 0x1f8fc9, 0x5f93ab, 0x8fa6b5, 0xc4d4dc, 0xeaf6f9];
export const FOG_COLOR = 0x060d18;
export const LEVELS = 8;
export const AMP = 1.1;
/** Mesh density per tier: [high, low]. */
export const SEGMENTS: [[number, number], [number, number]] = [[420, 260], [260, 160]];
export const CAM_BASE = new THREE.Vector3(0, 10.5, 5.0);

import { createRouter, createWebHistory } from 'vue-router'
import ArcBounceSim from '../components/ArcBounceSim.vue'
import EllipseSwarmSim from '../components/EllipseSwarmSim.vue'
import OrbitHarmonySim from '../components/OrbitHarmonySim.vue'
import FanBounceSim from '../components/FanBounceSim.vue'

// 每个实验页面对应一个路由；BASE_URL 来自 vite 的 base 配置（GitHub Pages 下为 /sim/）
export const routes = [
  { path: '/', redirect: '/arc' },
  {
    path: '/arc',
    name: 'arc',
    component: ArcBounceSim,
    meta: { label: '半圆弹跳', icon: 'arc' }
  },
  {
    path: '/ellipse',
    name: 'ellipse',
    component: EllipseSwarmSim,
    meta: { label: '层叠发散', icon: 'ell' }
  },
  {
    path: '/orbit',
    name: 'orbit',
    component: OrbitHarmonySim,
    meta: { label: '圆轨音阶', icon: 'orb' }
  },
  {
    path: '/fan',
    name: 'fan',
    component: FanBounceSim,
    meta: { label: 'V形扇摆', icon: 'fan' }
  },
  { path: '/:pathMatch(.*)*', redirect: '/arc' }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

export default router

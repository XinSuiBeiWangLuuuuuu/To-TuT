import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

// ============ Cesium 初始化 ============
const viewer = new Cesium.Viewer('cesiumContainer', {
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  baseLayerPicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  baseLayer: new Cesium.ImageryLayer(
    new Cesium.UrlTemplateImageryProvider({
      url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}',
      subdomains: ['1', '2', '3', '4'],
      maximumLevel: 18
    })
  )
});

viewer.scene.globe.enableLighting = false;
viewer.scene.skyAtmosphere.show = true;
viewer.scene.globe.showGroundAtmosphere = true;

const INITIAL_VIEW = {
  destination: Cesium.Cartesian3.fromDegrees(104, 30, 18000000),
  orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 }
};
viewer.camera.setView(INITIAL_VIEW);

viewer.scene.screenSpaceCameraController.enableZoom = false;
viewer.scene.canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const amount = viewer.camera.positionCartographic.height * 0.08;
  if (e.deltaY < 0) viewer.camera.zoomIn(amount);
  else viewer.camera.zoomOut(amount);
}, { passive: false });

// ============ 全局状态 ============
let currentPlaceId = null;
let currentMode = 'edit';
let currentDraft = null;
let categories = [];
let places = [];
let multiSelectMode = false;
const selectedPlaceIds = new Set();

let pendingMarkerEntity = null;
let pendingPosition = null;
let pendingPlaceName = '';
let pendingMarkerToken = 0;

let clickTimer = null;
function scheduleSingleClick(fn) {
  if (clickTimer) clearTimeout(clickTimer);
  clickTimer = setTimeout(() => { clickTimer = null; try { fn(); } catch (e) { console.error(e); } }, 220);
}
function cancelSingleClick() {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
}

let trailEntity = null;
let trailVisible = false;

let placeBgmAudio = null;
let softwareBgmAudio = null;

const entityIdOf = (id) => `place-${id}`;
const idOfEntity = (eid) => Number(String(eid).replace('place-', ''));

// ============ 待添加浮层 ============
const pendingLabelEl = document.createElement('div');
pendingLabelEl.className = 'pending-label hidden';
pendingLabelEl.innerHTML = '<div class="name"></div><div class="hint">双击此处添加</div>';
document.body.appendChild(pendingLabelEl);
const pendingLabelName = pendingLabelEl.querySelector('.name');

function updatePendingLabelPosition() {
  if (!pendingPosition || pendingLabelEl.classList.contains('hidden')) return;
  try {
    const cartesian = Cesium.Cartesian3.fromDegrees(pendingPosition.lon, pendingPosition.lat, 0);
    const screenPos = viewer.scene.cartesianToCanvasCoordinates(cartesian);
    if (!screenPos) { pendingLabelEl.classList.add('hidden'); return; }
    pendingLabelEl.style.left = screenPos.x + 'px';
    pendingLabelEl.style.top = screenPos.y + 'px';
  } catch (_) {
    pendingLabelEl.classList.add('hidden');
  }
}
viewer.scene.preRender.addEventListener(updatePendingLabelPosition);

function simplifyPlaceName(name) {
  if (!name) return '';
  const filtered = name.split(/[，,]/).map((s) => s.trim())
    .filter((s) => s && !/^(中华人民共和国|中国|China|中國)$/i.test(s));
  const short = filtered.slice(0, 3).join(' · ');
  return short.length > 40 ? short.slice(0, 40) + '…' : short;
}

async function showPendingMarker(lat, lon) {
  const token = ++pendingMarkerToken;
  if (pendingMarkerEntity) { viewer.entities.remove(pendingMarkerEntity); pendingMarkerEntity = null; }
  pendingPosition = { lat, lon };
  pendingPlaceName = '';
  const coordText = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  pendingMarkerEntity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: { pixelSize: 14, color: Cesium.Color.CYAN, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY }
  });
  pendingLabelName.textContent = coordText;
  pendingLabelEl.classList.remove('hidden');
  updatePendingLabelPosition();
  toast(`选中：${coordText}`);

  let result = { name: '' };
  try {
    result = await Promise.race([
      window.api.reverseGeo({ lat, lon }),
      new Promise((r) => setTimeout(() => r({ name: '' }), 4500))
    ]);
  } catch (e) { console.error(e); }
  if (token !== pendingMarkerToken) return;
  const displayName = result && result.name ? simplifyPlaceName(result.name) : '';
  if (displayName) {
    pendingPlaceName = result.name;
    pendingLabelName.textContent = displayName;
    toast(`选中：${displayName}`);
  } else {
    pendingLabelName.textContent = coordText;
  }
  updatePendingLabelPosition();
}

function clearPendingMarker() {
  if (pendingMarkerEntity) { viewer.entities.remove(pendingMarkerEntity); pendingMarkerEntity = null; }
  pendingLabelEl.classList.add('hidden');
  pendingPosition = null;
  pendingPlaceName = '';
  pendingMarkerToken++;
}

// ============ 右键菜单 ============
const contextMenu = document.createElement('div');
contextMenu.className = 'context-menu hidden';
document.body.appendChild(contextMenu);

function showContextMenu(x, y, items) {
  contextMenu.innerHTML = '';
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-sep';
      contextMenu.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'context-menu-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
    el.textContent = item.label;
    el.onclick = async (e) => {
      e.stopPropagation();
      if (item.disabled) return;
      hideContextMenu();
      if (item.action) { try { await item.action(); } catch (err) { console.error(err); } }
    };
    contextMenu.appendChild(el);
  }
  contextMenu.style.left = '0px';
  contextMenu.style.top = '0px';
  contextMenu.classList.remove('hidden');
  const rect = contextMenu.getBoundingClientRect();
  const margin = 8;
  let px = x, py = y;
  if (px + rect.width > window.innerWidth - margin) px = window.innerWidth - rect.width - margin;
  if (py + rect.height > window.innerHeight - margin) py = window.innerHeight - rect.height - margin;
  if (px < margin) px = margin;
  if (py < margin) py = margin;
  contextMenu.style.left = px + 'px';
  contextMenu.style.top = py + 'px';
}
function hideContextMenu() { contextMenu.classList.add('hidden'); }
window.addEventListener('pointerdown', (e) => {
  if (contextMenu.classList.contains('hidden')) return;
  if (contextMenu.contains(e.target)) return;
  hideContextMenu();
}, true);
window.addEventListener('blur', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);

// ============ 地点实体 ============
function addPlaceEntity(place) {
  const isFav = place.is_favorite == 1;
  const basePoint = {
    pixelSize: isFav ? 14 : 12,
    outlineColor: Cesium.Color.WHITE,
    outlineWidth: 2,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    scaleByDistance: new Cesium.NearFarScalar(1e5, 1.4, 1e7, 0.7)
  };

  if (isFav) {
    // 收藏地点：金色脉冲
    basePoint.color = new Cesium.CallbackProperty(() => {
      const t = Date.now() / 1000;
      const a = 0.7 + 0.3 * Math.sin(t * 2);
      return Cesium.Color.fromCssColorString('#ffd166').withAlpha(a);
    }, false);
    basePoint.pixelSize = new Cesium.CallbackProperty(() => {
      const t = Date.now() / 1000;
      return 14 + 3 * Math.sin(t * 2);
    }, false);
  } else {
    basePoint.color = Cesium.Color.fromCssColorString('#ff4d6d');
  }

  return viewer.entities.add({
    id: entityIdOf(place.id),
    name: place.name,
    position: Cesium.Cartesian3.fromDegrees(place.lon, place.lat, 0),
    point: basePoint,
    label: {
      text: (isFav ? '⭐ ' : '') + place.name,
      font: '14px "Microsoft YaHei", sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.fromCssColorString(isFav ? '#ffd166' : '#ff4d6d'),
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -26),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1.2e7),
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    }
  });
}

function updatePlaceEntity(place) {
  const e = viewer.entities.getById(entityIdOf(place.id));
  if (!e) return;
  // 简单起见，删除重建（保证收藏样式正确刷新）
  viewer.entities.remove(e);
  addPlaceEntity(place);
}

function removePlaceEntity(id) {
  const e = viewer.entities.getById(entityIdOf(id));
  if (e) viewer.entities.remove(e);
}

async function loadPlaces() {
  const list = await window.api.listPlaces();
  for (const p of list) addPlaceEntity(p);
}

async function reloadData() {
  categories = await window.api.listCategories();
  places = await window.api.listPlaces();
  renderSidebar();
  if (trailVisible) rebuildTrail();
}

// ============ 轨迹线 ============
function rebuildTrail() {
  if (trailEntity) { viewer.entities.remove(trailEntity); trailEntity = null; }
  if (!places.length || places.length < 2) return;
  const sorted = places.slice().sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const positions = sorted.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0));
  trailEntity = viewer.entities.add({
    polyline: {
      positions,
      width: 2.5,
      material: new Cesium.PolylineGlowMaterialProperty({
        color: Cesium.Color.fromCssColorString('#ff4d6d').withAlpha(0.75),
        glowPower: 0.25
      }),
      clampToGround: true
    }
  });
}
function toggleTrail() {
  trailVisible = !trailVisible;
  document.getElementById('trailBtn').classList.toggle('active', trailVisible);
  if (trailVisible) {
    rebuildTrail();
    toast(`轨迹线已开启（${places.length} 个地点）`);
  } else {
    if (trailEntity) { viewer.entities.remove(trailEntity); trailEntity = null; }
    toast('轨迹线已关闭');
  }
}

// ============ 昼夜模式 ============
let lightingOn = false;
function toggleLighting() {
  lightingOn = !lightingOn;
  viewer.scene.globe.enableLighting = lightingOn;
  document.getElementById('lightingBtn').classList.toggle('active', lightingOn);
  if (lightingOn) {
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date());
    toast('已切换为真实昼夜光照');
  } else {
    toast('已关闭昼夜光照');
  }
}

// ============ 随机回忆 ============
function randomMemory() {
  if (!places.length) { toast('还没有任何地点'); return; }
  const p = places[Math.floor(Math.random() * places.length)];
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 500000),
    duration: 2
  });
  setTimeout(() => openPlacePanel(p.id), 1600);
}

// ============ 那年今日 ============
function checkOnThisDay() {
  const now = new Date();
  const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const hits = places.filter((p) => p.created_at && p.created_at.slice(5, 10) === mmdd);
  if (!hits.length) return;
  const p = hits[0];
  setTimeout(() => {
    toast(`📅 一年前的今天，你在「${p.name}」`);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 400000),
      duration: 2
    });
    setTimeout(() => openPlacePanel(p.id), 2100);
  }, 3500);
}

// ============ BGM ============
function playPlaceBgm(path) {
  stopPlaceBgm();
  if (!path) return;
  try {
    const url = pathToPhotoUrl(path);
    placeBgmAudio = new Audio(url);
    placeBgmAudio.loop = true;
    placeBgmAudio.volume = 0.55;
    placeBgmAudio.play().catch((e) => console.warn('BGM 播放失败', e));
  } catch (e) { console.error(e); }
}
function stopPlaceBgm() {
  if (placeBgmAudio) { try { placeBgmAudio.pause(); } catch (_) {} placeBgmAudio = null; }
}

function applySoftwareBgm(path) {
  if (softwareBgmAudio) { try { softwareBgmAudio.pause(); } catch (_) {} softwareBgmAudio = null; }
  const btn = document.getElementById('musicBtn');
  if (btn) btn.classList.toggle('active', !!path);
  if (!path) return;
  try {
    softwareBgmAudio = new Audio(pathToPhotoUrl(path));
    softwareBgmAudio.loop = true;
    softwareBgmAudio.volume = 0.35;
    softwareBgmAudio.play().catch((e) => console.warn('软件 BGM 播放失败', e));
  } catch (e) { console.error(e); }
}

async function chooseSoftwareBgm() {
  const p = await window.api.chooseSoftwareBgm();
  if (p) { applySoftwareBgm(p); toast('软件背景音乐已设置'); }
}

// ============ 侧边栏 ============
const categoryListEl = document.getElementById('categoryList');

function renderSidebar() {
  categoryListEl.innerHTML = '';

  const favorites = places.filter((p) => p.is_favorite == 1);
  if (favorites.length) {
    categoryListEl.appendChild(renderCategoryGroup({ id: '__fav__', name: '⭐ 收藏' }, '⭐ 收藏', favorites, true));
  }

  const uncategorized = places.filter((p) => !p.category_id);
  categoryListEl.appendChild(renderCategoryGroup(null, '未分类', uncategorized));

  for (const cat of categories) {
    const items = places.filter((p) => p.category_id === cat.id);
    categoryListEl.appendChild(renderCategoryGroup(cat, cat.name, items));
  }
}

function renderCategoryGroup(cat, name, items, isFavGroup = false) {
  const group = document.createElement('div');
  group.className = 'cat-group';

  const header = document.createElement('div');
  header.className = 'cat-header';

  if (multiSelectMode) {
    const catCheck = document.createElement('input');
    catCheck.type = 'checkbox';
    catCheck.className = 'cat-check';
    const itemIds = items.map((p) => p.id);
    const allChecked = itemIds.length > 0 && itemIds.every((id) => selectedPlaceIds.has(id));
    const someChecked = itemIds.some((id) => selectedPlaceIds.has(id));
    catCheck.checked = allChecked;
    catCheck.indeterminate = !allChecked && someChecked;
    catCheck.disabled = itemIds.length === 0;
    catCheck.onclick = (e) => {
      e.stopPropagation();
      if (catCheck.checked) itemIds.forEach((id) => selectedPlaceIds.add(id));
      else itemIds.forEach((id) => selectedPlaceIds.delete(id));
      renderSidebar();
      updateBulkBar();
    };
    header.appendChild(catCheck);
  }

  const nameEl = document.createElement('span');
  nameEl.className = 'cat-name';
  nameEl.textContent = name;

  const count = document.createElement('span');
  count.className = 'cat-count';
  count.textContent = items.length;

  header.appendChild(nameEl);
  header.appendChild(count);

  if (cat && !isFavGroup) {
    const del = document.createElement('button');
    del.className = 'cat-del';
    del.textContent = '×';
    del.title = '删除分类';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`删除分类「${name}」？该分类下的地点会变为未分类。`)) return;
      await window.api.deleteCategory(cat.id);
      await reloadData();
    };
    header.appendChild(del);
  }

  header.onclick = () => {
    if (multiSelectMode) {
      const itemIds = items.map((p) => p.id);
      const allChecked = itemIds.length > 0 && itemIds.every((id) => selectedPlaceIds.has(id));
      if (allChecked) itemIds.forEach((id) => selectedPlaceIds.delete(id));
      else itemIds.forEach((id) => selectedPlaceIds.add(id));
      renderSidebar();
      updateBulkBar();
      return;
    }
    focusCategory(items);
  };

  if (cat && !isFavGroup && !multiSelectMode) {
    header.ondblclick = (e) => {
      e.stopPropagation();
      startCategoryRename(cat, nameEl);
    };
  }

  header.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (multiSelectMode) return;
    if (isFavGroup) return;
    showCategoryContextMenu(e.clientX, e.clientY, cat, name);
  };

  group.appendChild(header);

  const list = document.createElement('div');
  list.className = 'cat-places';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'cat-place';
    empty.style.color = '#5a6178';
    empty.style.cursor = 'default';
    empty.textContent = '（空）';
    list.appendChild(empty);
  } else {
    for (const p of items) {
      const item = document.createElement('div');
      item.className = 'cat-place';

      if (multiSelectMode) {
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'cat-place-check';
        check.checked = selectedPlaceIds.has(p.id);
        check.onclick = (e) => {
          e.stopPropagation();
          if (check.checked) selectedPlaceIds.add(p.id);
          else selectedPlaceIds.delete(p.id);
          renderSidebar();
          updateBulkBar();
        };
        item.appendChild(check);
      }

      const textSpan = document.createElement('span');
      textSpan.textContent = p.name;
      textSpan.style.flex = '1';
      textSpan.style.overflow = 'hidden';
      textSpan.style.textOverflow = 'ellipsis';
      textSpan.style.whiteSpace = 'nowrap';
      item.appendChild(textSpan);

      item.title = p.name;

      item.onclick = multiSelectMode
        ? (e) => {
            e.stopPropagation();
            if (selectedPlaceIds.has(p.id)) selectedPlaceIds.delete(p.id);
            else selectedPlaceIds.add(p.id);
            renderSidebar();
            updateBulkBar();
          }
        : async (e) => {
            e.stopPropagation();
            viewer.camera.flyTo({
              destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 500000),
              duration: 1.4
            });
            await openPlacePanel(p.id);
          };

      if (!multiSelectMode) {
        item.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          showPlaceContextMenu(e.clientX, e.clientY, p);
        };
      }

      list.appendChild(item);
    }
  }
  group.appendChild(list);
  return group;
}

function showCategoryContextMenu(x, y, cat, name) {
  if (!cat || cat.id === '__fav__') {
    showContextMenu(x, y, [
      { label: '➕ 新建分类', action: () => { addCategoryRow.classList.remove('hidden'); newCatNameInput.value = ''; requestAnimationFrame(() => newCatNameInput.focus()); } }
    ]);
    return;
  }
  showContextMenu(x, y, [
    { label: '✏️ 重命名分类', action: () => { const el = findCategoryNameEl(cat.id); if (el) startCategoryRename(cat, el); } },
    { label: '➕ 新建分类', action: () => { addCategoryRow.classList.remove('hidden'); newCatNameInput.value = ''; requestAnimationFrame(() => newCatNameInput.focus()); } },
    { sep: true },
    {
      label: '🗑 删除分类',
      danger: true,
      action: async () => {
        if (!confirm(`删除分类「${name}」？该分类下的地点会变为未分类。`)) return;
        await window.api.deleteCategory(cat.id);
        await reloadData();
      }
    }
  ]);
}

function findCategoryNameEl(catId) {
  const groups = categoryListEl.querySelectorAll('.cat-group');
  const idx = categories.findIndex((c) => c.id === catId);
  if (idx < 0) return null;
  const hasFav = places.some((p) => p.is_favorite == 1);
  const targetGroup = groups[idx + (hasFav ? 2 : 1)];
  if (!targetGroup) return null;
  return targetGroup.querySelector('.cat-name');
}

function showPlaceContextMenu(x, y, place) {
  showContextMenu(x, y, [
    { label: '📝 打开编辑', action: () => openPlacePanel(place.id) },
    { label: '✏️ 重命名', action: () => startPlaceRename(place) },
    { label: place.is_favorite ? '💔 取消收藏' : '⭐ 收藏', action: async () => {
      await window.api.toggleFavorite(place.id);
      const list = await window.api.listPlaces();
      const fresh = list.find((p) => p.id === place.id);
      if (fresh) updatePlaceEntity(fresh);
      await reloadData();
    } },
    { sep: true },
    {
      label: '🗑 删除地点',
      danger: true,
      action: async () => {
        if (!confirm(`删除地点「${place.name}」？此操作不可恢复。`)) return;
        await window.api.deletePlace(place.id);
        removePlaceEntity(place.id);
        if (currentPlaceId === place.id) await closePanel();
        await reloadData();
        toast('已删除');
      }
    }
  ]);
}

function startCategoryRename(cat, nameEl) {
  if (!nameEl) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = cat.name;
  input.className = 'cat-rename-input';
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const newName = input.value.trim();
    if (save && newName && newName !== cat.name) {
      await window.api.renameCategory({ id: cat.id, name: newName });
      await reloadData();
    } else {
      renderSidebar();
    }
  };
  input.onblur = () => finish(true);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); input.onblur = null; finish(false); }
  };
}

function startPlaceRename(place) {
  const groups = categoryListEl.querySelectorAll('.cat-group');
  const allPlaces = Array.from(groups).flatMap((g) => Array.from(g.querySelectorAll('.cat-place')));
  const target = allPlaces.find((el) => el.textContent === place.name && el.title === place.name);
  if (!target) return;
  const originalText = target.textContent;
  target.textContent = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = place.name;
  input.className = 'cat-rename-input';
  target.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const newName = input.value.trim();
    if (save && newName && newName !== place.name) {
      const updated = await window.api.updatePlace({ id: place.id, name: newName });
      if (updated) updatePlaceEntity(updated);
      await reloadData();
    } else {
      target.textContent = originalText;
    }
  };
  input.onblur = () => finish(true);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); input.onblur = null; finish(false); }
  };
}

function focusCategory(items) {
  if (!items.length) return;
  const entities = items.map((p) => viewer.entities.getById(entityIdOf(p.id))).filter(Boolean);
  if (entities.length) viewer.flyTo(entities, { duration: 1.5 });
}

// ============ 新建分类 ============
const addCategoryBtn = document.getElementById('addCategoryBtn');
const addCategoryRow = document.getElementById('addCategoryRow');
const newCatNameInput = document.getElementById('newCatName');

addCategoryBtn.onclick = () => {
  addCategoryRow.classList.remove('hidden');
  newCatNameInput.value = '';
  requestAnimationFrame(() => newCatNameInput.focus());
};
newCatNameInput.onkeydown = async (e) => {
  if (e.key === 'Enter') {
    const name = newCatNameInput.value.trim();
    if (name) {
      await window.api.addCategory(name);
      newCatNameInput.value = '';
      addCategoryRow.classList.add('hidden');
      await reloadData();
    } else {
      addCategoryRow.classList.add('hidden');
    }
  }
  if (e.key === 'Escape') { newCatNameInput.value = ''; addCategoryRow.classList.add('hidden'); }
};
newCatNameInput.onblur = () => {
  setTimeout(() => { if (newCatNameInput.value.trim() === '') addCategoryRow.classList.add('hidden'); }, 150);
};

// ============ 批量删除 ============
const multiSelectBtn = document.getElementById('multiSelectBtn');
const bulkBar = document.getElementById('bulkBar');
const bulkCount = document.getElementById('bulkCount');
const bulkSelectAll = document.getElementById('bulkSelectAll');
const bulkCancel = document.getElementById('bulkCancel');
const bulkDelete = document.getElementById('bulkDelete');

function enterMultiSelect() {
  multiSelectMode = true;
  selectedPlaceIds.clear();
  multiSelectBtn.classList.add('active');
  bulkBar.classList.remove('hidden');
  renderSidebar();
  updateBulkBar();
}
function exitMultiSelect() {
  multiSelectMode = false;
  selectedPlaceIds.clear();
  multiSelectBtn.classList.remove('active');
  bulkBar.classList.add('hidden');
  renderSidebar();
}
function updateBulkBar() {
  bulkCount.textContent = String(selectedPlaceIds.size);
  bulkDelete.disabled = selectedPlaceIds.size === 0;
}
multiSelectBtn.onclick = () => { if (multiSelectMode) exitMultiSelect(); else enterMultiSelect(); };
bulkCancel.onclick = exitMultiSelect;
bulkSelectAll.onclick = () => {
  if (selectedPlaceIds.size === places.length && places.length > 0) selectedPlaceIds.clear();
  else places.forEach((p) => selectedPlaceIds.add(p.id));
  renderSidebar();
  updateBulkBar();
};
bulkDelete.onclick = async () => {
  const ids = Array.from(selectedPlaceIds);
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 个地点吗？此操作不可恢复。`)) return;
  await window.api.deletePlacesBatch(ids);
  for (const id of ids) removePlaceEntity(id);
  if (currentPlaceId && selectedPlaceIds.has(currentPlaceId)) await closePanel();
  selectedPlaceIds.clear();
  exitMultiSelect();
  await reloadData();
  toast(`已删除 ${ids.length} 个地点`);
};

// ============ 底部面板 ============
const panel = document.getElementById('placePanel');
const nameInput = document.getElementById('placeName');
const coordEl = document.getElementById('placeCoord');
const categorySelect = document.getElementById('placeCategory');
const contentEditor = document.getElementById('contentEditor');
const saveStatusEl = document.getElementById('saveStatus');
const deletePlaceBtn = document.getElementById('deletePlaceBtn');
const saveBtn = document.getElementById('saveBtn');
const favBtn = document.getElementById('favBtn');
const placeBgmBar = document.getElementById('placeBgmBar');
const placeBgmName = document.getElementById('placeBgmName');
const changePlaceBgmBtn = document.getElementById('changePlaceBgmBtn');
const clearPlaceBgmBtn = document.getElementById('clearPlaceBgmBtn');

let saveTimer = null;
let currentSaveState = 'idle';
let currentIsFavorite = false;
let currentBgmPath = '';

function populateCategorySelect(currentCatId) {
  categorySelect.innerHTML = '<option value="">未分类</option>';
  for (const cat of categories) {
    const opt = document.createElement('option');
    opt.value = String(cat.id);
    opt.textContent = cat.name;
    if (Number(currentCatId) === cat.id) opt.selected = true;
    categorySelect.appendChild(opt);
  }
}

function setSaveState(state) {
  currentSaveState = state;
  saveStatusEl.classList.remove('dirty', 'saving', 'saved');
  switch (state) {
    case 'dirty': saveStatusEl.textContent = '● 未保存'; saveStatusEl.classList.add('dirty'); break;
    case 'saving': saveStatusEl.textContent = currentMode === 'new' ? '● 存入草稿…' : '● 保存中…'; saveStatusEl.classList.add('saving'); break;
    case 'saved':
      saveStatusEl.textContent = currentMode === 'new' ? '● 草稿已存' : '● 已保存';
      saveStatusEl.classList.add('saved');
      setTimeout(() => { if (currentSaveState === 'saved') { saveStatusEl.textContent = ''; saveStatusEl.classList.remove('saved'); } }, 2000);
      break;
    default: saveStatusEl.textContent = '';
  }
}

function updatePanelButtonsForMode() {
  if (currentMode === 'new') {
    saveBtn.textContent = '保存为地点';
    deletePlaceBtn.textContent = '🗑 丢弃草稿';
    deletePlaceBtn.title = '丢弃这份未保存的草稿';
  } else {
    saveBtn.textContent = '保存';
    deletePlaceBtn.textContent = '🗑 删除';
    deletePlaceBtn.title = '删除地点';
  }
}

function draftHasContent() {
  const name = nameInput.value.trim();
  const content = contentEditor.innerHTML;
  const hasName = name && name !== '新地点' && name !== '未命名';
  const hasContent = content && content.trim() && content !== '<br>' && content !== '<p><br></p>';
  const hasCategory = !!categorySelect.value;
  return hasName || hasContent || hasCategory;
}

function updateFavBtn() {
  favBtn.textContent = currentIsFavorite ? '★' : '☆';
  favBtn.classList.toggle('active', currentIsFavorite);
}

function updatePlaceBgmBar() {
  if (currentBgmPath) {
    placeBgmBar.classList.remove('hidden');
    const parts = currentBgmPath.split(/[\\/]/);
    placeBgmName.textContent = parts[parts.length - 1];
  } else {
    placeBgmBar.classList.add('hidden');
    placeBgmName.textContent = '';
  }
}

async function openPlacePanel(placeId) {
  const list = await window.api.listPlaces();
  const place = list.find((p) => p.id === placeId);
  if (!place) return;

  clearPendingMarker();
  currentMode = 'edit';
  currentDraft = null;
  currentPlaceId = placeId;
  currentIsFavorite = place.is_favorite == 1;
  currentBgmPath = place.bgm_file || '';

  nameInput.value = place.name;
  coordEl.textContent = `${Number(place.lat).toFixed(4)}° , ${Number(place.lon).toFixed(4)}°`;
  contentEditor.innerHTML = place.content || '';
  populateCategorySelect(place.category_id);
  updateFavBtn();
  updatePlaceBgmBar();
  setSaveState('idle');
  updatePanelButtonsForMode();

  panel.classList.remove('hidden');
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 120);

  // 播放该地点的 BGM
  if (currentBgmPath) playPlaceBgm(currentBgmPath);
}

async function openNewPlacePanel(lat, lon, defaultName) {
  const existing = await window.api.loadDraft();
  currentMode = 'new';
  currentPlaceId = null;
  currentIsFavorite = false;
  currentBgmPath = '';

  const hasRealContent = existing && (
    (existing.name && existing.name !== '新地点') ||
    (existing.content && existing.content.trim() && existing.content !== '<br>') ||
    existing.category_id
  );

  if (hasRealContent) {
    currentDraft = {
      lat, lon,
      name: existing.name || defaultName || '新地点',
      content: existing.content || '',
      category_id: existing.category_id ?? null,
      updatedAt: Date.now()
    };
    await window.api.saveDraft(currentDraft);
    toast('已恢复上次未保存的草稿内容，位置已更新');
  } else {
    currentDraft = {
      lat, lon,
      name: defaultName || '新地点',
      content: '',
      category_id: null,
      updatedAt: Date.now()
    };
  }

  nameInput.value = currentDraft.name || '新地点';
  coordEl.textContent = `${Number(currentDraft.lat).toFixed(4)}° , ${Number(currentDraft.lon).toFixed(4)}°`;
  contentEditor.innerHTML = currentDraft.content || '';
  populateCategorySelect(currentDraft.category_id);
  updateFavBtn();
  updatePlaceBgmBar();
  setSaveState('idle');
  updatePanelButtonsForMode();

  panel.classList.remove('hidden');
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 120);
}

async function performSave(showToastFlag = false) {
  const name = nameInput.value.trim() || '新地点';
  const content = contentEditor.innerHTML;
  const catValue = categorySelect.value;
  const catId = catValue ? Number(catValue) : null;

  if (currentMode === 'new') {
    if (!draftHasContent()) { toast('请先写点什么，或点「丢弃草稿」'); return; }
    setSaveState('saving');
    const place = await window.api.addPlace({
      name, lat: currentDraft.lat, lon: currentDraft.lon, category_id: catId
    });
    await window.api.updatePlace({ id: place.id, name, content, category_id: catId });
    currentMode = 'edit';
    currentPlaceId = place.id;
    currentDraft = null;
    await window.api.clearDraft();
    addPlaceEntity(place);
    const fresh = (await window.api.listPlaces()).find((p) => p.id === place.id);
    if (fresh) updatePlaceEntity(fresh);
    updatePanelButtonsForMode();
    setSaveState('saved');
    if (showToastFlag) toast('已保存 ♥');
    await reloadData();
  } else {
    if (!currentPlaceId) return;
    setSaveState('saving');
    const updated = await window.api.updatePlace({
      id: currentPlaceId, name, content, category_id: catId
    });
    if (updated) {
      updatePlaceEntity(updated);
      setSaveState('saved');
      if (showToastFlag) toast('已保存 ♥');
      await reloadData();
    }
  }
}

function scheduleSave() {
  setSaveState('dirty');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (currentMode === 'new' && currentDraft) {
      setSaveState('saving');
      currentDraft.name = nameInput.value.trim() || '新地点';
      currentDraft.content = contentEditor.innerHTML;
      currentDraft.category_id = categorySelect.value ? Number(categorySelect.value) : null;
      currentDraft.updatedAt = Date.now();
      await window.api.saveDraft(currentDraft);
      setSaveState('saved');
    } else {
      performSave(false);
    }
  }, 800);
}

async function closePanel() {
  if (currentMode === 'new' && currentDraft) {
    if (draftHasContent()) {
      currentDraft.name = nameInput.value.trim() || '新地点';
      currentDraft.content = contentEditor.innerHTML;
      currentDraft.category_id = categorySelect.value ? Number(categorySelect.value) : null;
      currentDraft.updatedAt = Date.now();
      await window.api.saveDraft(currentDraft);
      toast('草稿已保存，双击地球可继续');
    } else {
      await window.api.clearDraft();
    }
  } else if (currentMode === 'edit' && currentSaveState === 'dirty') {
    if (saveTimer) clearTimeout(saveTimer);
    await performSave(false);
  }

  stopPlaceBgm();

  currentPlaceId = null;
  currentDraft = null;
  currentMode = 'edit';
  currentIsFavorite = false;
  currentBgmPath = '';
  panel.classList.add('hidden');
  panel.classList.remove('expanded');
  updatePlaceBgmBar();
}

document.getElementById('closePanel').onclick = () => closePanel();
document.getElementById('expandBtn').onclick = () => panel.classList.toggle('expanded');

contentEditor.addEventListener('input', scheduleSave);
nameInput.addEventListener('input', scheduleSave);
categorySelect.addEventListener('change', scheduleSave);

saveBtn.onclick = () => { if (saveTimer) clearTimeout(saveTimer); performSave(true); };

favBtn.onclick = async () => {
  if (currentMode === 'new') { toast('保存后可以收藏'); return; }
  if (!currentPlaceId) return;
  const updated = await window.api.toggleFavorite(currentPlaceId);
  if (updated) {
    currentIsFavorite = updated.is_favorite == 1;
    updateFavBtn();
    updatePlaceEntity(updated);
    await reloadData();
    toast(currentIsFavorite ? '已收藏 ⭐' : '已取消收藏');
  }
};

changePlaceBgmBtn.onclick = async () => {
  if (currentMode === 'new') { toast('保存后可以添加 BGM'); return; }
  if (!currentPlaceId) return;
  const p = await window.api.setPlaceBgm(currentPlaceId);
  if (p) {
    currentBgmPath = p;
    updatePlaceBgmBar();
    playPlaceBgm(p);
    toast('已设置地点 BGM ♥');
    await reloadData();
  }
};

clearPlaceBgmBtn.onclick = async () => {
  if (!currentPlaceId) return;
  if (!confirm('移除这个地点的背景音乐？')) return;
  await window.api.clearPlaceBgm(currentPlaceId);
  currentBgmPath = '';
  stopPlaceBgm();
  updatePlaceBgmBar();
  toast('已移除地点 BGM');
  await reloadData();
};

// ============ 快捷键 ============
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (currentPlaceId || currentMode === 'new') {
      if (saveTimer) clearTimeout(saveTimer);
      performSave(true);
    }
    return;
  }
  if (e.key !== 'Escape') return;

  if (!nameModal.classList.contains('hidden')) return;
  if (!celebrateModal.classList.contains('hidden')) { hideCelebration(); e.preventDefault(); return; }
  if (!tutorialModal.classList.contains('hidden')) { finishTutorial(); e.preventDefault(); return; }
  if (!contextMenu.classList.contains('hidden')) { hideContextMenu(); e.preventDefault(); return; }

  const historyModal = document.getElementById('historyModal');
  if (historyModal && !historyModal.classList.contains('hidden')) { historyModal.classList.add('hidden'); e.preventDefault(); return; }

  const mask = document.querySelector('.img-preview-mask');
  if (mask) { mask.remove(); e.preventDefault(); return; }

  const templateMenu = document.getElementById('templateMenu');
  if (templateMenu && !templateMenu.classList.contains('hidden')) { templateMenu.classList.add('hidden'); e.preventDefault(); return; }

  if (!panel.classList.contains('hidden')) { closePanel(); e.preventDefault(); return; }

  window.api.exitFullscreen();
});

deletePlaceBtn.onclick = async () => {
  if (currentMode === 'new') {
    if (!confirm('丢弃这份未保存的草稿？')) return;
    await window.api.clearDraft();
    currentDraft = null;
    currentMode = 'edit';
    await closePanel();
    toast('草稿已丢弃');
    return;
  }
  if (!currentPlaceId) return;
  if (!confirm('确定删除这个地点和它的所有记录吗？此操作不可恢复。')) return;
  await window.api.deletePlace(currentPlaceId);
  removePlaceEntity(currentPlaceId);
  await closePanel();
  await reloadData();
  toast('已删除');
};

// ============ 工具栏 ============
document.querySelectorAll('.toolbar-btn[data-cmd]').forEach((btn) => {
  btn.onmousedown = (e) => {
    e.preventDefault();
    const cmd = btn.dataset.cmd;
    const value = btn.dataset.value || null;
    document.execCommand(cmd, false, value);
    contentEditor.focus();
    scheduleSave();
  };
});

// ============ 模板 ============
const templateBtn = document.getElementById('templateBtn');
const templateMenu = document.getElementById('templateMenu');
const TEMPLATES = {
  travel: `<h3>🗺️ 行程</h3><p><br></p><h3>📍 亮点</h3><ul><li></li></ul><h3>💭 感受</h3><p><br></p>`,
  food: `<h3>🍽️ 吃了什么</h3><p><br></p><h3>😋 味道</h3><p><br></p><h3>💡 推荐指数</h3><p>★★★★★</p>`,
  walk: `<h3>🚶 路线</h3><p><br></p><h3>🌿 看到了什么</h3><p><br></p><h3>💭 心情</h3><p><br></p>`,
  milestone: `<h3>💖 今天是什么日子</h3><p><br></p><h3>📸 纪念</h3><p><br></p><h3>🎯 想对未来说的</h3><p><br></p>`
};
templateBtn.onclick = (e) => { e.stopPropagation(); templateMenu.classList.toggle('hidden'); };
document.addEventListener('click', () => templateMenu.classList.add('hidden'));
templateMenu.querySelectorAll('.template-item').forEach((item) => {
  item.onclick = (e) => {
    e.stopPropagation();
    const tpl = TEMPLATES[item.dataset.tpl];
    if (!tpl) return;
    if (!contentEditor.innerHTML.trim() || contentEditor.innerHTML === '<br>') contentEditor.innerHTML = tpl;
    else contentEditor.innerHTML += tpl;
    templateMenu.classList.add('hidden');
    contentEditor.focus();
    scheduleSave();
  };
});

// ============ 媒体 ============
function pathToPhotoUrl(filePath) {
  if (!filePath) return '';
  const bytes = new TextEncoder().encode(filePath);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `photo://local/${btoa(binary)}`;
}
function buildFigure(media) {
  const figure = document.createElement('figure');
  const url = pathToPhotoUrl(media.file_path || '');
  if (media.kind === 'video') {
    const video = document.createElement('video');
    video.src = url; video.controls = true; video.preload = 'metadata';
    figure.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.src = url;
    img.onclick = (e) => { e.preventDefault(); openMediaPreview(url, 'image'); };
    figure.appendChild(img);
  }
  const cap = document.createElement('figcaption');
  cap.contentEditable = 'true';
  cap.dataset.captionFor = media.id;
  figure.appendChild(cap);
  return figure;
}
function insertNodeAtCursor(node) {
  contentEditor.focus();
  const sel = window.getSelection();
  if (sel.rangeCount && contentEditor.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else contentEditor.appendChild(node);
  const p = document.createElement('p'); p.innerHTML = '<br>';
  node.parentNode.insertBefore(p, node.nextSibling);
}
async function insertMedia(kind) {
  if (currentMode === 'new') {
    if (!draftHasContent()) { toast('请先给这个地点起个名字'); return; }
    await performSave(false);
  }
  if (!currentPlaceId) { toast('请先打开一个地点'); return; }
  const items = await window.api.addMedia({ placeId: currentPlaceId, kind });
  if (!items || !items.length) return;
  for (const item of items) insertNodeAtCursor(buildFigure(item));
  scheduleSave();
  toast(kind === 'video' ? '已插入视频' : '已插入图片');
}
document.getElementById('insertImageBtn').onclick = () => insertMedia('image');
document.getElementById('insertVideoBtn').onclick = () => insertMedia('video');

contentEditor.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const mediaItem = items.find((it) => it.type.startsWith('image/') || it.type.startsWith('video/'));
  if (!mediaItem) return;
  if (currentMode === 'new') {
    if (!draftHasContent()) { toast('请先给这个地点起个名字'); return; }
    await performSave(false);
  }
  if (!currentPlaceId) return;
  e.preventDefault();
  const file = mediaItem.getAsFile();
  if (!file) return;
  const kind = file.type.startsWith('video/') ? 'video' : 'image';
  const ext = file.name.includes('.') ? '.' + file.name.split('.').pop() : (kind === 'video' ? '.mp4' : '.png');
  const fileName = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const buf = await file.arrayBuffer();
  const item = await window.api.savePastedMedia({ placeId: currentPlaceId, kind, fileName, buffer: new Uint8Array(buf) });
  if (item) { insertNodeAtCursor(buildFigure(item)); scheduleSave(); }
});
contentEditor.addEventListener('dragover', (e) => { e.preventDefault(); contentEditor.classList.add('drag-over'); });
contentEditor.addEventListener('dragleave', () => contentEditor.classList.remove('drag-over'));
contentEditor.addEventListener('drop', async (e) => {
  e.preventDefault();
  contentEditor.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  if (currentMode === 'new') {
    if (!draftHasContent()) { toast('请先给这个地点起个名字'); return; }
    await performSave(false);
  }
  if (!currentPlaceId) return;
  for (const file of files) {
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) continue;
    const buf = await file.arrayBuffer();
    const ext = file.name.includes('.') ? '.' + file.name.split('.').pop() : '';
    const fileName = `drop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const item = await window.api.savePastedMedia({ placeId: currentPlaceId, kind: isVideo ? 'video' : 'image', fileName, buffer: new Uint8Array(buf) });
    if (item) insertNodeAtCursor(buildFigure(item));
  }
  scheduleSave();
});

function openMediaPreview(url, kind) {
  const mask = document.createElement('div');
  mask.className = 'img-preview-mask';
  const el = kind === 'video' ? document.createElement('video') : document.createElement('img');
  el.src = url; if (kind === 'video') el.controls = true;
  mask.appendChild(el);
  mask.onclick = () => mask.remove();
  document.body.appendChild(mask);
}

// ============ 历史版本 ============
const historyModal = document.getElementById('historyModal');
const historyList = document.getElementById('historyList');
document.getElementById('historyBtn').onclick = async () => {
  if (currentMode === 'new') { toast('草稿还没有历史版本'); return; }
  if (!currentPlaceId) { toast('请先打开一个地点'); return; }
  await renderHistoryList();
  historyModal.classList.remove('hidden');
};
document.getElementById('historyClose').onclick = () => historyModal.classList.add('hidden');
historyModal.addEventListener('click', (e) => { if (e.target === historyModal) historyModal.classList.add('hidden'); });
async function renderHistoryList() {
  const revisions = await window.api.listRevisions(currentPlaceId);
  historyList.innerHTML = '';
  if (!revisions.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '还没有历史版本。每次编辑保存后会自动生成。';
    historyList.appendChild(empty);
    return;
  }
  for (const rev of revisions) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const time = document.createElement('div');
    time.className = 'history-time';
    time.textContent = rev.created_at;
    const preview = document.createElement('div');
    preview.className = 'history-preview';
    const tmp = document.createElement('div');
    tmp.innerHTML = rev.content || '';
    const text = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
    preview.textContent = (rev.name || '') + (text ? ' · ' + text.slice(0, 40) : '');
    preview.title = text.slice(0, 200);
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'history-restore';
    restoreBtn.textContent = '恢复';
    restoreBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('恢复到这个版本？当前内容会先被保存为一条新历史。')) return;
      const updated = await window.api.restoreRevision({ placeId: currentPlaceId, revisionId: rev.id });
      if (updated) {
        nameInput.value = updated.name;
        contentEditor.innerHTML = updated.content || '';
        updatePlaceEntity(updated);
        setSaveState('saved');
        toast('已恢复到该版本');
        historyModal.classList.add('hidden');
        await reloadData();
      }
    };
    item.appendChild(time);
    item.appendChild(preview);
    item.appendChild(restoreBtn);
    historyList.appendChild(item);
  }
}

// ============ 地球交互 ============
const canvas = viewer.scene.canvas;
let pointerDown = null;
const DRAG_THRESHOLD = 4;

function isAnyModalOpen() {
  const ids = ['placePanel', 'nameModal', 'tutorialModal', 'celebrateModal', 'historyModal'];
  return ids.some((id) => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); });
}

canvas.addEventListener('pointerdown', (e) => {
  if (isAnyModalOpen()) return;
  if (e.button !== 0) return;
  if (!contextMenu.classList.contains('hidden')) hideContextMenu();

  const rect = canvas.getBoundingClientRect();
  const pos = new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top);
  const picked = viewer.scene.pick(pos);
  const entityId = Cesium.defined(picked) && picked.id && typeof picked.id.id === 'string' && picked.id.id.startsWith('place-')
    ? idOfEntity(picked.id.id) : null;

  pointerDown = { x: e.clientX, y: e.clientY, entityId, hasMoved: false, pointerId: e.pointerId };

  if (entityId !== null) {
    viewer.scene.screenSpaceCameraController.enableInputs = false;
    const entity = viewer.entities.getById(entityIdOf(entityId));
    if (entity && entity.point) {
      entity.point.pixelSize = 18;
      entity.point.color = Cesium.Color.fromCssColorString('#ffd166');
    }
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

canvas.addEventListener('pointermove', (e) => {
  if (isAnyModalOpen()) return;
  if (!pointerDown) return;
  const dx = Math.abs(e.clientX - pointerDown.x);
  const dy = Math.abs(e.clientY - pointerDown.y);
  if (!pointerDown.hasMoved && (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD)) pointerDown.hasMoved = true;
  if (pointerDown.entityId === null) return;
  if (!pointerDown.hasMoved) return;
  const rect = canvas.getBoundingClientRect();
  const pos = new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top);
  const ray = viewer.camera.getPickRay(pos);
  const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
  if (!cartesian) return;
  const entity = viewer.entities.getById(entityIdOf(pointerDown.entityId));
  if (entity) entity.position = cartesian;
}, true);

canvas.addEventListener('pointerup', async (e) => {
  if (isAnyModalOpen()) return;
  if (!pointerDown) return;
  const { entityId, hasMoved } = pointerDown;
  pointerDown = null;
  viewer.scene.screenSpaceCameraController.enableInputs = true;

  if (entityId !== null) {
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    const entity = viewer.entities.getById(entityIdOf(entityId));
    if (entity && entity.point) {
      entity.point.pixelSize = 12;
      entity.point.color = Cesium.Color.fromCssColorString('#ff4d6d');
    }
  }

  if (entityId !== null && hasMoved) {
    const entity = viewer.entities.getById(entityIdOf(entityId));
    if (entity) {
      const position = entity.position.getValue(Cesium.JulianDate.now());
      const carto = Cesium.Cartographic.fromCartesian(position);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const updated = await window.api.updatePlace({ id: entityId, lat, lon });
      if (updated) {
        updatePlaceEntity(updated);
        await reloadData();
        if (currentPlaceId === entityId) coordEl.textContent = `${lat.toFixed(4)}° , ${lon.toFixed(4)}°`;
        toast('位置已更新 ♥');
      }
    }
    return;
  }

  if (entityId !== null && !hasMoved) { await openPlacePanel(entityId); return; }

  if (entityId === null && !hasMoved) {
    const rect = canvas.getBoundingClientRect();
    const pos = new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top);
    const ray = viewer.camera.getPickRay(pos);
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    scheduleSingleClick(() => showPendingMarker(lat, lon));
  }
}, true);

canvas.addEventListener('pointercancel', () => {
  if (!pointerDown) return;
  viewer.scene.screenSpaceCameraController.enableInputs = true;
  if (pointerDown.entityId !== null) {
    const entity = viewer.entities.getById(entityIdOf(pointerDown.entityId));
    if (entity && entity.point) {
      entity.point.pixelSize = 12;
      entity.point.color = Cesium.Color.fromCssColorString('#ff4d6d');
    }
  }
  pointerDown = null;
}, true);

canvas.addEventListener('dblclick', async (e) => {
  cancelSingleClick();
  const rect = canvas.getBoundingClientRect();
  const pos = new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top);
  const picked = viewer.scene.pick(pos);

  if (Cesium.defined(picked) && picked.id && typeof picked.id.id === 'string' && picked.id.id.startsWith('place-')) {
    await openPlacePanel(idOfEntity(picked.id.id));
    return;
  }

  let lat, lon, defaultName = '';
  if (pendingPosition) {
    lat = pendingPosition.lat; lon = pendingPosition.lon; defaultName = pendingPlaceName;
  } else {
    const ray = viewer.camera.getPickRay(pos);
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    lat = Cesium.Math.toDegrees(carto.latitude);
    lon = Cesium.Math.toDegrees(carto.longitude);
  }
  clearPendingMarker();
  await openNewPlacePanel(lat, lon, defaultName);
});

canvas.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const pos = new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top);
  const picked = viewer.scene.pick(pos);

  if (Cesium.defined(picked) && picked.id && typeof picked.id.id === 'string' && picked.id.id.startsWith('place-')) {
    const id = idOfEntity(picked.id.id);
    const place = places.find((p) => p.id === id);
    if (place) showPlaceContextMenu(e.clientX, e.clientY, place);
    return;
  }

  const ray = viewer.camera.getPickRay(pos);
  const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
  if (!cartesian) return;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);

  showContextMenu(e.clientX, e.clientY, [
    { label: '➕ 在此新增地点', action: async () => { clearPendingMarker(); await openNewPlacePanel(lat, lon); } }
  ]);
});

// ============ 搜索 ============
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  searchResults.innerHTML = '<div class="result-item">搜索中…</div>';
  searchResults.classList.remove('hidden');
  const results = await window.api.search(q);
  searchResults.innerHTML = '';
  if (!results.length) { searchResults.innerHTML = '<div class="result-item">没有找到结果</div>'; return; }
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'result-item';
    const icon = r.source === 'amap' ? '🇨🇳 ' : r.source === 'openmeteo' ? '🌍 ' : '';
    div.textContent = icon + r.name;
    div.onclick = () => {
      viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 600000), duration: 1.8 });
      searchResults.classList.add('hidden');
      const tmp = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 0),
        point: { pixelSize: 10, color: Cesium.Color.CYAN, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: r.name.split('，')[0].split('（')[0],
          font: '13px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.CYAN, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -26),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      setTimeout(() => viewer.entities.remove(tmp), 4500);
    };
    searchResults.appendChild(div);
  }
}
searchBtn.onclick = doSearch;
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
  if (e.key === 'Escape') searchResults.classList.add('hidden');
});
document.addEventListener('click', (e) => { if (!e.target.closest('.topbar')) searchResults.classList.add('hidden'); });

// ============ Toast ============
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}
window.api.onToast((msg) => toast(msg));
window.api.onMediaDirChanged?.(() => {
  if (currentPlaceId) {
    const pid = currentPlaceId;
    closePanel().then(() => openPlacePanel(pid));
  }
});

// ============ 更新 ============
const updateBar = document.getElementById('updateBar');
const updateText = document.getElementById('updateText');
const updateAction = document.getElementById('updateAction');
const updateClose = document.getElementById('updateClose');
function showUpdateBar(text, label = null, fn = null) {
  updateText.textContent = text;
  updateBar.classList.remove('hidden');
  if (label) { updateAction.textContent = label; updateAction.classList.remove('hidden'); updateAction.onclick = fn; }
  else { updateAction.classList.add('hidden'); updateAction.onclick = null; }
}
updateClose.onclick = () => updateBar.classList.add('hidden');
window.api.onUpdateStatus((data) => {
  switch (data.status) {
    case 'available': showUpdateBar(`发现新版本 v${data.version}，正在后台下载…`); break;
    case 'downloading': showUpdateBar(`正在下载更新… ${data.percent}%`); break;
    case 'downloaded': showUpdateBar(`新版本 v${data.version} 已下载完成`, '立即重启', () => window.api.installUpdate()); break;
  }
});

// ============ 名字弹窗 ============
const nameModal = document.getElementById('nameModal');
const nameField = document.getElementById('nameInput');
const nameSubmit = document.getElementById('nameSubmit');
const sidebarTitle = document.getElementById('sidebarTitle');

function applyUserName(name) {
  sidebarTitle.textContent = name && name.trim() ? `📁 ${name} 的目录` : '📁 我的目录';
}
function showNamePrompt() {
  nameModal.classList.remove('hidden');
  requestAnimationFrame(() => { nameField.value = ''; nameField.focus(); });
}
async function onNameSubmit() {
  const name = nameField.value.trim();
  if (!name) {
    nameField.focus();
    nameField.animate([
      { transform: 'translateX(0)' }, { transform: 'translateX(-6px)' },
      { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' },
      { transform: 'translateX(0)' }
    ], { duration: 300 });
    return;
  }
  await window.api.setUserName(name);
  applyUserName(name);
  nameModal.classList.add('hidden');
  const s = await window.api.getSettings();
  if (!s.hasSeenTutorial) setTimeout(() => showTutorial(), 400);
  else toast(`欢迎回来，${name} ♥`);
}
nameSubmit.onclick = onNameSubmit;
nameField.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onNameSubmit(); } });
window.api.onShowNamePrompt(() => showNamePrompt());

// ============ 里程碑 ============
const celebrateModal = document.getElementById('celebrateModal');
const celebrateEmoji = document.getElementById('celebrateEmoji');
const celebrateCount = document.getElementById('celebrateCount');
const celebrateTitle = document.getElementById('celebrateTitle');
const celebrateText = document.getElementById('celebrateText');
const celebrateClose = document.getElementById('celebrateClose');
function showCelebration(data) {
  celebrateEmoji.textContent = data.emoji || '✨';
  celebrateCount.textContent = `第 ${data.count} 个地点`;
  celebrateTitle.textContent = data.title || '里程碑';
  celebrateText.textContent = data.text || '';
  celebrateModal.classList.remove('hidden');
}
function hideCelebration() { celebrateModal.classList.add('hidden'); }
celebrateClose.onclick = hideCelebration;
celebrateModal.addEventListener('click', (e) => { if (e.target === celebrateModal) hideCelebration(); });
window.api.onMilestone((data) => showCelebration(data));

// ============ 新手教程 ============
const tutorialModal = document.getElementById('tutorialModal');
const tutorialStep = document.getElementById('tutorialStep');
const tutorialDots = document.getElementById('tutorialDots');
const tutorialPages = document.querySelectorAll('.tutorial-page');
const tutorialPrev = document.getElementById('tutorialPrev');
const tutorialNext = document.getElementById('tutorialNext');
const tutorialSkip = document.getElementById('tutorialSkip');
const TUTORIAL_TOTAL = tutorialPages.length;
let tutorialIndex = 0;
for (let i = 0; i < TUTORIAL_TOTAL; i++) {
  const dot = document.createElement('div');
  dot.className = 'tutorial-dot';
  dot.dataset.index = String(i);
  tutorialDots.appendChild(dot);
}
function updateTutorial() {
  tutorialPages.forEach((p, i) => p.classList.toggle('hidden', i !== tutorialIndex));
  tutorialStep.textContent = `${tutorialIndex + 1} / ${TUTORIAL_TOTAL}`;
  tutorialPrev.disabled = tutorialIndex === 0;
  tutorialNext.textContent = tutorialIndex === TUTORIAL_TOTAL - 1 ? '完成' : '下一页';
  Array.from(tutorialDots.children).forEach((d, i) => d.classList.toggle('active', i === tutorialIndex));
}
async function finishTutorial() { tutorialModal.classList.add('hidden'); try { await window.api.setTutorialSeen(); } catch (_) {} }
function showTutorial() { tutorialIndex = 0; updateTutorial(); tutorialModal.classList.remove('hidden'); }
tutorialPrev.onclick = () => { if (tutorialIndex > 0) { tutorialIndex--; updateTutorial(); } };
tutorialNext.onclick = () => {
  if (tutorialIndex < TUTORIAL_TOTAL - 1) { tutorialIndex++; updateTutorial(); }
  else finishTutorial();
};
tutorialSkip.onclick = () => finishTutorial();
tutorialDots.addEventListener('click', (e) => {
  const dot = e.target.closest('.tutorial-dot');
  if (!dot) return;
  tutorialIndex = Number(dot.dataset.index);
  updateTutorial();
});
window.api.onShowTutorial(() => showTutorial());

// ============ 地图工具栏绑定 ============
document.getElementById('randomBtn').onclick = randomMemory;
document.getElementById('trailBtn').onclick = toggleTrail;
document.getElementById('lightingBtn').onclick = toggleLighting;
document.getElementById('musicBtn').onclick = async () => {
  const s = await window.api.getSettings();
  if (s.softwareBgmPath) {
    const action = confirm('当前已有软件背景音乐。\n\n点「确定」选择新音乐，点「取消」移除。');
    if (action) await chooseSoftwareBgm();
    else { await window.api.clearSoftwareBgm(); applySoftwareBgm(''); toast('已移除软件背景音乐'); }
  } else {
    await chooseSoftwareBgm();
  }
};

// ============ 启动 ============
(async () => {
  await loadPlaces();
  await reloadData();

  const s = await window.api.getSettings();
  if (!s.userName) {
    showNamePrompt();
  } else {
    applyUserName(s.userName);
    if (!s.hasSeenTutorial) setTimeout(() => showTutorial(), 400);
    else setTimeout(() => toast(`欢迎回来，${s.userName} ♥`), 800);
  }

  // 软件 BGM 自动播放
  if (s.softwareBgmPath) {
    applySoftwareBgm(s.softwareBgmPath);
  }

  // 那年今日
  checkOnThisDay();

  const draft = await window.api.loadDraft();
  if (draft && ((draft.name && draft.name !== '新地点') || (draft.content && draft.content.trim() && draft.content !== '<br>'))) {
    setTimeout(() => toast('有一份未保存的草稿，双击地球可继续'), 2500);
  }

  window.api.getAppInfo().then((info) => console.log('[MemoryEarth]', info));
})();
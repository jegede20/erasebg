"use client";
import { get, set, del, keys } from "idb-keyval";

export type RecentItem = {
  id: string;
  name: string;
  createdAt: number;
  originalDataUrl: string;
  resultDataUrl: string;
  width: number;
  height: number;
  size: number;
};

const PREFIX = "erasebg:recent:";
const INDEX_KEY = "erasebg:recent:index";
const MAX_ITEMS = 24;

export async function saveRecent(item: RecentItem) {
  await set(PREFIX + item.id, item);
  const idx = (await get<string[]>(INDEX_KEY)) || [];
  const next = [item.id, ...idx.filter(id => id !== item.id)].slice(0, MAX_ITEMS);
  await set(INDEX_KEY, next);
  // prune old
  if (idx.length >= MAX_ITEMS) {
    const toDelete = idx.slice(MAX_ITEMS - 1);
    for (const id of toDelete) {
      if (!next.includes(id)) await del(PREFIX + id);
    }
  }
}

export async function getRecentAll(): Promise<RecentItem[]> {
  const idx = (await get<string[]>(INDEX_KEY)) || [];
  const items: RecentItem[] = [];
  for (const id of idx) {
    const v = await get<RecentItem>(PREFIX + id);
    if (v) items.push(v);
  }
  // fallback: if index missing, scan keys
  if (items.length === 0) {
    const allKeys = await keys();
    for (const k of allKeys) {
      if (typeof k === "string" && k.startsWith(PREFIX)) {
        const v = await get<RecentItem>(k);
        if (v) items.push(v);
      }
    }
    items.sort((a,b)=> b.createdAt - a.createdAt);
  }
  return items;
}

export async function deleteRecent(id: string) {
  await del(PREFIX + id);
  const idx = (await get<string[]>(INDEX_KEY)) || [];
  await set(INDEX_KEY, idx.filter(x => x !== id));
}

export async function clearRecent() {
  const idx = (await get<string[]>(INDEX_KEY)) || [];
  for (const id of idx) await del(PREFIX + id);
  await set(INDEX_KEY, []);
  // also scan stray
  const allKeys = await keys();
  for (const k of allKeys) {
    if (typeof k === "string" && k.startsWith(PREFIX)) await del(k);
  }
}

export async function getRecent(id: string) {
  return get<RecentItem>(PREFIX + id);
}

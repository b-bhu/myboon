import type { ComponentProps } from 'react';
import type MaterialIcons from '@expo/vector-icons/MaterialIcons';

export type FeedCategory = string;

export interface PredictOutcome {
  label: string;
  price: number; // 0.0–1.0
}

export interface NarrativeAction {
  type: 'predict' | 'perps';
  asset?: string; // perps: 'BTC', 'ETH'
  slug?: string;  // predict: polymarket slug
}

export interface FeedItem {
  id: string;
  category: FeedCategory;
  createdAt: string; // ISO timestamp — timeAgo computed dynamically
  headline: string;
  description: string;
  isTop?: boolean;
  actions: NarrativeAction[];
  imageUrl?: string | null;
  imageKind?: 'content' | 'source_avatar' | null;
  imageAttribution?: string | null;
}

export interface StorySummary {
  storySlug: string;
  name: string;
  latestDevelopment: string;
  eventCount: number;
  updatedAt: string;
  imageUrl: string | null;
  imageKind: 'content' | 'source_avatar' | null;
  imageAttribution: string | null;
}

export interface StoryEvent {
  text: string;
  eventAt: string;
  imageUrl: string | null;
  imageKind: 'content' | 'source_avatar' | null;
  imageAttribution: string | null;
}

export interface StoryDetail {
  story: StorySummary;
  events: StoryEvent[];
}

export interface BottomNavItem {
  key: string;
  icon: ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  route: '/' | '/markets/polymarket' | '/swap' | '/markets/pacifica';
}

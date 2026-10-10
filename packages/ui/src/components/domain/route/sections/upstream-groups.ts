import { sortBy } from 'lodash-es';
import type { Upstream } from '$api/routes';

export interface PriorityGroup {
    priority: number;
    groupIndex: number;
    upstreams: (Upstream & { originalIndex: number })[];
  }

export function groupUpstreams(upstreams: Upstream[], searchTerm = ''): PriorityGroup[] {
    const withIndex = upstreams.map((u, i) => ({ ...u, originalIndex: i }));
    const sorted = sortBy(withIndex, [(u) => u.priority || 1]);

    const groups: PriorityGroup[] = [];
    let currentGroup: PriorityGroup | null = null;

    for (const u of sorted) {
      const priority = u.priority || 1;

      if (!currentGroup || currentGroup.priority !== priority) {
        currentGroup = { priority, groupIndex: groups.length, upstreams: [] };
        groups.push(currentGroup);
      }

      currentGroup.upstreams.push(u);
    }

    const query = searchTerm.trim().toLowerCase();
    if (!query) return groups;
    // Preserve full-list endpoint and group indices; search is only a projection.
    return groups.map(group => ({
      ...group,
      upstreams: group.upstreams.filter(upstream =>
        [upstream.target, upstream.description].some(value => value?.toLowerCase().includes(query))),
    })).filter(group => group.upstreams.length > 0);
  }

export function flattenGroups(groups: PriorityGroup[]): Upstream[] {
    const flattened: Upstream[] = [];

    groups.forEach((group, index) => {
      // Priority is 1-based index of the group
      const newPriority = index + 1;

      group.upstreams.forEach(u => {
        const { originalIndex, ...upstreamData } = u;
        flattened.push({
          ...upstreamData,
          priority: newPriority
        });
      });
    });

    return flattened;
  }

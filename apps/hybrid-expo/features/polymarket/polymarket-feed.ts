type FeedSectionLike = {
  data: readonly unknown[];
};

const DEFAULT_INITIAL_RENDER_COUNT = 10;
const SECTION_BOUNDARY_CELL_COUNT = 2;

/**
 * React Native Web can leave later SectionList cells unmounted when its
 * virtualized render window does not advance. Keep native virtualization, but
 * include the complete published feed in the web list's retained first region.
 */
export function getInitialFeedRenderCount(
  sections: readonly FeedSectionLike[],
  isWeb: boolean,
): number | undefined {
  if (!isWeb) return undefined;

  const flattenedCellCount = sections.reduce(
    (total, section) => total + section.data.length + SECTION_BOUNDARY_CELL_COUNT,
    0,
  );

  return Math.max(DEFAULT_INITIAL_RENDER_COUNT, flattenedCellCount);
}

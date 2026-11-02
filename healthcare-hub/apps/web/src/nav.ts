/** Left navigation from the wireframes (PRD §3). Items for modules not built yet are marked. */
export const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/staff', label: 'Staff' },
  { to: '/vehicles', label: 'Vehicles and assets' },
  { to: '/compliance', label: 'Compliance' },
  { to: '/premises', label: 'Premises safety' },
  { to: '/planner', label: 'Work planner' },
  { to: '/reports', label: 'Reports' },
  { to: '/settings', label: 'Settings' },
] as const;

/**
 * How many parts' lines the viewer fetches at once, at most. More wait their
 * turn, so no action, such as unticking a whole group of 2,000 files, can send
 * the daemon (or the browser) more than it can take. Its own module, with
 * nothing imported, so the speed test can check the page keeps to it.
 */
export const PART_REQUESTS_AT_ONCE = 6;

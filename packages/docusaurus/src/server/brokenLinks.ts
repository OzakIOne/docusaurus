/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import _ from 'lodash';
import logger from '@docusaurus/logger';
import {matchRoutes} from 'react-router-config';
import {resolvePathname} from '@docusaurus/utils';
import {getAllFinalRoutes} from './utils';
import type {RouteConfig, ReportingSeverity} from '@docusaurus/types';

type BrokenLink = {
  link: string;
  resolvedLink: string;
  anchor: boolean;
};

type BrokenLinksByLocation = {[location: string]: BrokenLink[]};

type CollectedLinks = {
  [location: string]: {links: string[]; anchors: string[]};
};

// matchRoutes does not support qs/anchors, so we remove it!
function onlyPathname(link: string) {
  return link.split('#')[0]!.split('?')[0]!;
}

// TODO move to docusaurus-utils + add tests
// Let's name the concept of (pathname + search + hash) as URL path
// See also https://twitter.com/kettanaito/status/1741768992866308120
// A possible alternative? https://github.com/unjs/ufo#url
function parseURLPath(
  urlPath: string,
  fromPath?: string,
): {pathname: string; search?: string; hash?: string} {
  function parseURL(url: string, base?: string | URL): URL {
    try {
      return new URL(url, base ?? 'https://example.com');
    } catch (e) {
      throw new Error(
        `Can't parse URL ${url}${base ? ` with base ${base}` : ''}`,
        {cause: e},
      );
    }
  }

  const base = fromPath ? parseURL(fromPath) : undefined;
  const url = parseURL(urlPath, base);

  const {pathname} = url;

  // Fixes annoying url.search behavior
  // "" => undefined
  // "?" => ""
  // "?param => "param"
  const search = url.search
    ? url.search.slice(1)
    : urlPath.includes('?')
    ? ''
    : undefined;

  // Fixes annoying url.hash behavior
  // "" => undefined
  // "#" => ""
  // "?param => "param"
  const hash = url.hash
    ? url.hash.slice(1)
    : urlPath.includes('#')
    ? ''
    : undefined;

  return {
    pathname,
    search,
    hash,
  };
}

function getPageBrokenLinks({
  allCollectedLinks,
  pagePath,
  pageLinks,
  routes,
}: {
  allCollectedLinks: CollectedLinks;
  pagePath: string;
  pageLinks: string[];
  pageAnchors: string[];
  routes: RouteConfig[];
}): BrokenLink[] {
  // ReactRouter is able to support links like ./../somePath but `matchRoutes`
  // does not do this resolution internally. We must resolve the links before
  // using `matchRoutes`. `resolvePathname` is used internally by React Router
  function resolveLink(link: string) {
    const resolvedLink = resolvePathname(onlyPathname(link), pagePath);
    return resolvedLink;
  }

  // console.log('routes:', routes);
  function isPathBrokenLink(link: string) {
    const matchedRoutes = [link, decodeURI(link)]
      // @ts-expect-error: React router types RouteConfig with an actual React
      // component, but we load route components with string paths.
      // We don't actually access component here, so it's fine.
      .map((l) => matchRoutes(routes, l))
      .flat();
    return matchedRoutes.length === 0;
  }

  function isAnchorBrokenLink(pageLink: string) {
    const {pathname, hash} = parseURLPath(pageLink, pagePath);

    // Link has no hash: it can't be a broken anchor link
    if (hash === undefined) {
      return false;
    }

    const targetPage = allCollectedLinks[pathname];

    // link with anchor to a page that does not exist (or did not collect any
    // link/anchor) is considered as a broken anchor
    if (!targetPage) {
      return true;
    }

    // it's a broken anchor if the target page exists
    // but the anchor does not exist on that page
    return !targetPage.anchors.includes(hash);
  }

  const brokenLinks = pageLinks.flatMap((pageLink) => {
    const resolvedLink = resolveLink(pageLink);
    if (isPathBrokenLink(resolvedLink)) {
      return [{link: pageLink, resolvedLink, anchor: false}];
    }
    if (isAnchorBrokenLink(pageLink)) {
      return [{link: pageLink, resolvedLink, anchor: true}];
    }
    return [];
  });

  return brokenLinks;
}

/**
 * The route defs can be recursive, and have a parent match-all route. We don't
 * want to match broken links like /docs/brokenLink against /docs/*. For this
 * reason, we only consider the "final routes" that do not have subroutes.
 * We also need to remove the match-all 404 route
 */
function filterIntermediateRoutes(routesInput: RouteConfig[]): RouteConfig[] {
  const routesWithout404 = routesInput.filter((route) => route.path !== '*');
  return getAllFinalRoutes(routesWithout404);
}

function getAllBrokenLinks({
  allCollectedLinks,
  routes,
}: {
  allCollectedLinks: CollectedLinks;
  routes: RouteConfig[];
}): {brokenLinks: BrokenLinksByLocation; brokenAnchors: BrokenLinksByLocation} {
  const filteredRoutes = filterIntermediateRoutes(routes);

  const allBrokenLinks = _.mapValues(
    allCollectedLinks,
    (pageCollectedData, pagePath) =>
      getPageBrokenLinks({
        allCollectedLinks,
        pageLinks: pageCollectedData.links,
        pageAnchors: pageCollectedData.anchors,
        pagePath,
        routes: filteredRoutes,
      }),
  );

  function splitBrokenLinks(collect: {[x: string]: BrokenLink[]}) {
    const brokenLinks: {[x: string]: BrokenLink[]} = {};
    const brokenAnchors: {[x: string]: BrokenLink[]} = {};

    Object.entries(collect).forEach(([page, links]) => {
      const [linksFiltered, anchorsFiltered] = _.partition(
        links,
        (link) => link.anchor === false,
      );

      if (linksFiltered.length > 0) {
        brokenLinks[page] = linksFiltered;
      }
      if (anchorsFiltered.length > 0) {
        brokenAnchors[page] = anchorsFiltered;
      }
    });

    return {brokenLinks, brokenAnchors};
  }

  return splitBrokenLinks(allBrokenLinks);
}

function brokenLinkMessage(brokenLink: BrokenLink): string {
  const showResolvedLink = brokenLink.link !== brokenLink.resolvedLink;
  return `${brokenLink.link}${
    showResolvedLink ? ` (resolved as: ${brokenLink.resolvedLink})` : ''
  }`;
}

function createBrokenLinksMessage(
  pagePath: string,
  allBrokenLinks: BrokenLink[],
): string {
  const type = allBrokenLinks[0]?.anchor === true ? 'anchor' : 'link';

  const anchorMessage =
    allBrokenLinks.length > 0
      ? `- Broken ${type} on source page path = ${pagePath}:
   -> linking to ${allBrokenLinks
     .map(brokenLinkMessage)
     .join('\n   -> linking to ')}`
      : '';

  return `${anchorMessage}`;
}

function getAnchorBrokenLinksErrorMessage(allBrokenLinks: {
  [location: string]: BrokenLink[];
}): string | undefined {
  if (Object.keys(allBrokenLinks).length === 0) {
    return undefined;
  }

  return `Docusaurus found broken anchors!

Please check the pages of your site in the list below, and make sure you don't reference any anchor that does not exist.
Note: it's possible to ignore broken anchors with the 'onBrokenAnchors' Docusaurus configuration, and let the build pass.

Exhaustive list of all broken anchors found:
${Object.entries(allBrokenLinks)
  .map(([pagePath, brokenLinks]) =>
    createBrokenLinksMessage(pagePath, brokenLinks),
  )
  .join('\n')}
`;
}

function getPathBrokenLinksErrorMessage(allBrokenLinks: {
  [location: string]: BrokenLink[];
}): string | undefined {
  if (Object.keys(allBrokenLinks).length === 0) {
    return undefined;
  }

  /**
   * If there's a broken link appearing very often, it is probably a broken link
   * on the layout. Add an additional message in such case to help user figure
   * this out. See https://github.com/facebook/docusaurus/issues/3567#issuecomment-706973805
   */
  function getLayoutBrokenLinksHelpMessage() {
    const flatList = Object.entries(allBrokenLinks).flatMap(
      ([pagePage, brokenLinks]) =>
        brokenLinks.map((brokenLink) => ({pagePage, brokenLink})),
    );

    const countedBrokenLinks = _.countBy(
      flatList,
      (item) => item.brokenLink.link,
    );

    const FrequencyThreshold = 5; // Is this a good value?
    const frequentLinks = Object.entries(countedBrokenLinks)
      .filter(([, count]) => count >= FrequencyThreshold)
      .map(([link]) => link);

    if (frequentLinks.length === 0) {
      return '';
    }

    return logger.interpolate`

It looks like some of the broken links we found appear in many pages of your site.
Maybe those broken links appear on all pages through your site layout?
We recommend that you check your theme configuration for such links (particularly, theme navbar and footer).
Frequent broken links are linking to:${frequentLinks}`;
  }

  return `Docusaurus found broken links!

Please check the pages of your site in the list below, and make sure you don't reference any path that does not exist.
Note: it's possible to ignore broken links with the 'onBrokenLinks' Docusaurus configuration, and let the build pass.${getLayoutBrokenLinksHelpMessage()}

Exhaustive list of all broken links found:
${Object.entries(allBrokenLinks)
  .map(([pagePath, brokenLinks]) =>
    createBrokenLinksMessage(pagePath, brokenLinks),
  )
  .join('\n')}
`;
}

export async function handleBrokenLinks({
  allCollectedLinks,
  onBrokenLinks,
  onBrokenAnchors,
  routes,
}: {
  allCollectedLinks: CollectedLinks;
  onBrokenLinks: ReportingSeverity;
  onBrokenAnchors: ReportingSeverity;
  routes: RouteConfig[];
}): Promise<void> {
  if (onBrokenLinks === 'ignore' && onBrokenAnchors === 'ignore') {
    return;
  }

  const {brokenLinks, brokenAnchors} = getAllBrokenLinks({
    allCollectedLinks,
    routes,
  });

  const pathErrorMessage = getPathBrokenLinksErrorMessage(brokenLinks);
  if (pathErrorMessage) {
    logger.report(onBrokenLinks)(pathErrorMessage);
  }

  const anchorErrorMessage = getAnchorBrokenLinksErrorMessage(brokenAnchors);
  if (anchorErrorMessage) {
    logger.report(onBrokenAnchors)(anchorErrorMessage);
  }
}

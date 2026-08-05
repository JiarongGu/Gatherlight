import type { ComponentType, ReactNode } from 'react';
import { Stack, Row, Card, Divider } from './layout';
import { Heading, Text, List, Badge, Image, Table, Map, Link, FileRef } from './content';
import { Button } from './interactive';

/** A validated node, as the server sends it: flat props, plus children. */
export interface UiNode {
  type: string;
  children?: UiNode[];
  [prop: string]: unknown;
}

export interface UiNodeProps {
  node: UiNode;
  /** Rendered children, already resolved by UiTree. */
  children?: ReactNode;
  /** Send text back to the agent — supplied by the chat mount, absent on a page. */
  onSend?: (text: string) => void;
  /** Open a record file in the reader. */
  onOpenRecord?: (path: string) => void;
}

/**
 * The type→component map. `UI_COMPONENTS` is the list `dev.mjs check-ui-registry` compares against
 * the server's registered IUiNodeSchema types: the schema lives in C# and the renderer lives here,
 * so nothing but that check would notice the two drifting apart.
 */
export const RENDERERS: Record<string, ComponentType<UiNodeProps>> = {
  Stack, Row, Card, Divider,
  Heading, Text, List, Badge, Image, Table, Map, Link, FileRef,
  Button,
};

export const UI_COMPONENTS = Object.keys(RENDERERS).sort();

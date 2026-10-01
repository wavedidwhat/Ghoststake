"use client";
import React from "react";
import { ProjectPreview } from "@webprodigies/flute/preview";
import { sceneModules } from "./catalog";
// Host-owned development flag: no process, Vite or Electron globals in this adapter.
export function FluteProjectPreview({ children, enabled, active, ...props }) {
  if (!enabled) return children;
  return <ProjectPreview {...props} projectId="2226c739-8302-4bbf-9723-4164afe21049" enabled={enabled} active={active} sceneModules={sceneModules}>{children}</ProjectPreview>;
}

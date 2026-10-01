import React from "react";
import { notFound } from "next/navigation";
import FluteStudio from "../../../src/flute/Studio";
export default function FlutePage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <><meta name="flute-project" content="2226c739-8302-4bbf-9723-4164afe21049" /><FluteStudio /></>;
}

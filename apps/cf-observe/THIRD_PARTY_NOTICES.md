# Third-party notices

CF Observe's original application code is provided under the MIT License.

`src/protobuf.js` contains independently written decoder logic and protocol field mappings derived from the OpenTelemetry Protocol definitions in the OpenTelemetry Authors' `open-telemetry/opentelemetry-proto` project, licensed under Apache License 2.0. The mappings were adapted into JavaScript and are not an upstream generated decoder. A copy of Apache-2.0 is included at `licenses/Apache-2.0.txt`. Preserve this notice when redistributing the field mappings.

Sources:
- https://github.com/open-telemetry/opentelemetry-proto
- https://github.com/open-telemetry/opentelemetry-proto/blob/main/LICENSE
- https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto
- https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
- https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto

Wrangler is a development-only dependency installed separately. Its own license and notices apply. There are no bundled third-party runtime packages, fonts or image assets. Demo records are synthetic.

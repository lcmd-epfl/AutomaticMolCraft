import React from 'react'
import { axisLabelExpressionToPlainText, parseAxisLabelExpression } from '../utils/axisSettings'

export default function AxisLabelText({ label }: { label: string }) {
  const segments = parseAxisLabelExpression(label)
  return (
    <span data-export-label={axisLabelExpressionToPlainText(label)}>
      {segments.map((segment, index) => {
        if (segment.kind === 'sub') return <sub key={index}>{segment.text}</sub>
        if (segment.kind === 'sup') return <sup key={index}>{segment.text}</sup>
        return <React.Fragment key={index}>{segment.text}</React.Fragment>
      })}
    </span>
  )
}

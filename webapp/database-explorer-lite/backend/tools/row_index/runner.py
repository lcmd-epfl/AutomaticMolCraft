def run_tool(dataset, params):
    ids = dataset.get("ids", [])
    n = len(ids)

    column_name = params.get("target_name")
    start_at = params.get("start_at", 0)

    values = [start_at + i for i in range(n)]

    return {
        "message": f"Added column '{column_name}' with {n} row indices.",
        "warnings": [],
        "addColumns": [
            {
                "name": column_name,
                "kind": "numeric",
                "values": values,
            }
        ],
        "stats": {
            "rowsProcessed": n,
            "startAt": start_at,
        },
    }

export default function Loading() {
  return (
    <main className="min-h-screen bg-gray-50 p-8 animate-pulse">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div className="h-8 bg-gray-200 rounded w-64"></div>
          <div className="h-6 bg-gray-200 rounded-full w-24"></div>
        </div>

        {/* Stats Grid Skeleton */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 h-24">
              <div className="h-4 bg-gray-200 rounded w-20 mb-3"></div>
              <div className="h-8 bg-gray-200 rounded w-12"></div>
            </div>
          ))}
        </div>

        {/* Filter Skeleton */}
        <div className="mb-4 flex gap-2">
          <div className="h-8 bg-gray-200 rounded w-16"></div>
          <div className="h-8 bg-gray-200 rounded w-20"></div>
          <div className="h-8 bg-gray-200 rounded w-20"></div>
          <div className="h-8 bg-gray-200 rounded w-20"></div>
        </div>

        {/* Table Skeleton */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex gap-4">
            <div className="h-6 bg-gray-200 rounded w-32"></div>
          </div>
          <div className="p-6 space-y-4">
             {[...Array(5)].map((_, i) => (
               <div key={i} className="h-10 bg-gray-200 rounded w-full"></div>
             ))}
          </div>
        </div>
      </div>
    </main>
  );
}
